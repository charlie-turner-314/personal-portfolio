import { categoryAccess, categoryDefinitionForActor, categorySelectionHidden } from "@/lib/household/category-access";
// Cached read layer. NOT a "use server" module.
// Two cache layers:
// - React.cache: per-request dedup (no TTL, scoped to a single render).
// - unstable_cache: onboarding only. Vocabulary and account access are checked live.
// Mutations MUST call revalidateTag(...) for the relevant tag below.

import { accountAccess } from "@/lib/household/account-access";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, categories, users, householdAccountShares } from "@/lib/db/schema";
import { getAuthenticatedSession as getFinancialSession } from "@/lib/household/financial-auth";
import { getAuthenticatedSession } from "@/lib/auth-helpers";
import { resolveMissingAccountLogos } from "@/lib/actions/account-logos";
import type { OnboardingStatus, OnboardingStatusResult } from "@/lib/actions/onboarding";

export const CACHE_TAGS = {
  categories: (userId: string) => `categories:${userId}`,
  accounts: (userId: string) => `accounts:${userId}`,
  onboarding: (userId: string) => `onboarding:${userId}`,
} as const;

export const getCachedSession = cache(async () => {
  return getAuthenticatedSession();
});

// ---------- Categories ----------

async function fetchCategoriesForUser(userId: string) {
  const rows = await db.query.categories.findMany({
    where: categoryAccess(userId),
    extras: { selectionHidden: categorySelectionHidden(userId).as("selection_hidden") },
    orderBy: (c, { asc }) => [asc(c.name), asc(c.id)],
  });
  return rows.map(category => ({ ...categoryDefinitionForActor(category,userId), hideFromSelection: category.selectionHidden }));
}

// Membership and retained classification access are evaluated on every request.
const getCachedCategoriesByUser = fetchCategoriesForUser;

export const getCachedUserCategories = cache(async () => {
  const session = await getFinancialSession();
  const userId = session?.user?.id;
  if (!userId) return [];
  return getCachedCategoriesByUser(userId);
});

// ---------- Accounts (slim, for filter dropdowns) ----------

async function fetchAccountsForUser(userId: string) {
  return db
    .select({
      id: accounts.id,
      name: accounts.name,
      institution: accounts.institution,
      accountType: accounts.accountType,
      currency: accounts.currency,
    })
    .from(accounts)
    .where(and(accountAccess(accounts.id, userId), eq(accounts.isActive, true)))
    .orderBy(accounts.name);
}

const getCachedAccountsByUser = fetchAccountsForUser;

export const getCachedUserAccounts = cache(async () => {
  const session = await getFinancialSession();
  const userId = session?.user?.id;
  if (!userId) return [];
  return getCachedAccountsByUser(userId);
});

// ---------- Accounts (full, with logos — superset for getAccounts) ----------

async function fetchFullAccountsForUser(userId: string) {
  const accountRows = await db.query.accounts.findMany({
    where: and(accountAccess(accounts.id, userId), eq(accounts.isActive, true)),
    orderBy: (accounts, { asc }) => [asc(accounts.name)],
    with: {
      logo: {
        columns: {
          id: true,
          logoUrl: true,
          updatedAt: true,
        },
      },
    },
  });
  const resolved = await resolveMissingAccountLogos(accountRows);
  // Provider identifiers and connection linkage are personal integration metadata.
  const ownedIds = resolved.filter((account) => account.userId === userId).map((account) => account.id);
  const shares = ownedIds.length ? await db.select({ accountId: householdAccountShares.accountId }).from(householdAccountShares)
    .where(and(inArray(householdAccountShares.accountId, ownedIds), eq(householdAccountShares.grantedByUserId, userId))) : [];
  const sharedIds = new Set(shares.map((share) => share.accountId));
  return resolved.map((account) => account.userId === userId
    ? { ...account, accessMode: "owner" as const, visibility: sharedIds.has(account.id) ? "Shared" : "Private" }
    : { ...account, accessMode: "shared" as const, visibility: "Shared with you", externalId: null, externalIdCiphertext: null, externalIdHash: null,
      ibanCiphertext: null, ibanHash: null, bankConnectionId: null });
}

const getCachedFullAccountsByUser = fetchFullAccountsForUser;

export const getCachedFullUserAccounts = cache(async () => {
  const session = await getFinancialSession();
  const userId = session?.user?.id;
  if (!userId) return [];
  return getCachedFullAccountsByUser(userId);
});

// ---------- Onboarding status ----------
// Inlined DB lookup (mirrors lib/actions/onboarding.ts#getOnboardingStatus) to
// avoid a circular import: that module is "use server" and pulls in storage,
// constants, and other action modules.

async function fetchOnboardingStatusForUser(
  userId: string,
): Promise<OnboardingStatusResult | null> {
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      console.warn(`[Onboarding] User not found: ${userId}`);
      return null;
    }

    const status = (user.onboardingStatus as OnboardingStatus) || "pending";

    return {
      status,
      isCompleted: status === "completed",
    };
  } catch (error: any) {
    console.error("[Onboarding] Failed to get onboarding status:", {
      error: error?.message || String(error),
      stack: error?.stack,
      userId,
      databaseUrl: process.env.DATABASE_URL ? "set" : "not set",
    });
    return {
      status: "pending",
      isCompleted: false,
    };
  }
}

const getCachedOnboardingStatusByUser = (userId: string) =>
  unstable_cache(
    () => fetchOnboardingStatusForUser(userId),
    ["onboarding", userId],
    { tags: [CACHE_TAGS.onboarding(userId)] },
  )();

export const getCachedOnboardingStatus = cache(async () => {
  const session = await getFinancialSession();
  const userId = session?.user?.id;
  if (!userId) return null;
  return getCachedOnboardingStatusByUser(userId);
});
