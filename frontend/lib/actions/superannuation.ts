"use server";

import { and, desc, eq, inArray } from "drizzle-orm";
import { revalidatePath, updateTag } from "next/cache";
import { db } from "@/lib/db";
import {
  accountBalances,
  accounts,
  superAccounts,
  superContributionCaps,
  superContributions,
} from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-helpers";
import { CACHE_TAGS } from "@/lib/data/cached";
import {
  calculateSuperCapProgress,
  isSuperContributionKind,
  type SuperContributionForProgress,
  type SuperContributionKind,
} from "@/lib/superannuation/cap-progress";

export interface SuperAccountInput {
  fundName: string;
  investmentOption?: string | null;
  includeInNetWorth?: boolean;
}

export interface SuperContributionInput {
  date: string;
  amount: number;
  currency?: string;
  kind: SuperContributionKind;
  notes?: string | null;
}

function parsedDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 12));

  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    ? date
    : null;
}

function isValidFinancialYearStart(value: number): boolean {
  return Number.isInteger(value) && value >= 1900 && value <= 9998;
}

async function findOwnedSuperAccount(accountId: string, userId: string) {
  return db.query.superAccounts.findFirst({
    where: and(eq(superAccounts.accountId, accountId), eq(superAccounts.userId, userId)),
    with: { account: true },
  });
}

function revalidateSuperPaths(userId: string, accountId?: string) {
  revalidatePath("/");
  revalidatePath("/assets");
  revalidatePath("/settings");
  if (accountId) revalidatePath(`/accounts/${accountId}`);
  updateTag(CACHE_TAGS.accounts(userId));
}

export async function createSuperAccountMetadata(
  accountId: string,
  input: SuperAccountInput,
): Promise<{ success: boolean; error?: string; superAccountId?: string }> {
  const userId = await requireAuth();
  if (!userId) return { success: false, error: "Not authenticated" };
  const fundName = input.fundName.trim();
  if (!fundName) return { success: false, error: "Fund or provider is required" };

  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.id, accountId), eq(accounts.userId, userId)),
  });
  if (!account || account.accountType !== "superannuation") {
    return { success: false, error: "Super details can only be added to a superannuation account" };
  }

  try {
    const [record] = await db.insert(superAccounts).values({
      accountId,
      userId,
      fundName,
      investmentOption: input.investmentOption?.trim() || null,
      includeInNetWorth: input.includeInNetWorth ?? true,
    }).onConflictDoNothing().returning({ id: superAccounts.id });
    if (!record) return { success: false, error: "Super details already exist for this account" };
    revalidateSuperPaths(userId, accountId);
    return { success: true, superAccountId: record.id };
  } catch (error) {
    console.error("Failed to create super account metadata", error);
    return { success: false, error: "Failed to save super account details" };
  }
}

export async function updateSuperAccountMetadata(
  accountId: string,
  input: SuperAccountInput,
): Promise<{ success: boolean; error?: string }> {
  const userId = await requireAuth();
  if (!userId) return { success: false, error: "Not authenticated" };
  const record = await findOwnedSuperAccount(accountId, userId);
  if (!record || record.account.accountType !== "superannuation") {
    return { success: false, error: "Super account not found" };
  }
  const fundName = input.fundName.trim();
  if (!fundName) return { success: false, error: "Fund or provider is required" };
  await db.update(superAccounts).set({
    fundName,
    investmentOption: input.investmentOption?.trim() || null,
    includeInNetWorth: input.includeInNetWorth ?? true,
    updatedAt: new Date(),
  }).where(eq(superAccounts.id, record.id));
  revalidateSuperPaths(userId, accountId);
  return { success: true };
}

export async function addSuperContribution(
  accountId: string,
  input: SuperContributionInput,
): Promise<{ success: boolean; error?: string; contributionId?: string }> {
  const userId = await requireAuth();
  if (!userId) return { success: false, error: "Not authenticated" };
  const record = await findOwnedSuperAccount(accountId, userId);
  if (!record || record.account.accountType !== "superannuation") {
    return { success: false, error: "Super account not found" };
  }
  const date = parsedDate(input.date);
  if (!date || input.amount <= 0 || !Number.isFinite(input.amount) || !isSuperContributionKind(input.kind)) {
    return { success: false, error: "Enter a valid date, positive amount, and contribution type" };
  }
  const kind: SuperContributionKind = input.kind;
  const [contribution] = await db.insert(superContributions).values({
    userId,
    superAccountId: record.id,
    date: input.date,
    amount: input.amount.toFixed(2),
    currency: (input.currency || record.account.currency || "AUD").toUpperCase(),
    kind,
    notes: input.notes?.trim() || null,
  }).returning({ id: superContributions.id });
  revalidateSuperPaths(userId, accountId);
  return { success: true, contributionId: contribution.id };
}

export async function addSuperBalanceSnapshot(
  accountId: string,
  input: { date: string; balance: number },
): Promise<{ success: boolean; error?: string }> {
  const userId = await requireAuth();
  if (!userId) return { success: false, error: "Not authenticated" };
  const record = await findOwnedSuperAccount(accountId, userId);
  if (!record || record.account.accountType !== "superannuation") {
    return { success: false, error: "Super account not found" };
  }
  if (!parsedDate(input.date) || input.balance < 0 || !Number.isFinite(input.balance)) {
    return { success: false, error: "Enter a valid date and non-negative balance" };
  }
  const balance = input.balance.toFixed(2);
  await db.insert(accountBalances).values({
    accountId,
    date: new Date(`${input.date}T12:00:00.000Z`),
    balanceInAccountCurrency: balance,
    balanceInFunctionalCurrency: balance,
  }).onConflictDoUpdate({
    target: [accountBalances.accountId, accountBalances.date],
    set: { balanceInAccountCurrency: balance, balanceInFunctionalCurrency: balance, updatedAt: new Date() },
  });
  await db.update(accounts).set({ functionalBalance: balance, updatedAt: new Date() }).where(eq(accounts.id, accountId));
  revalidateSuperPaths(userId, accountId);
  return { success: true };
}

export async function saveSuperContributionCaps(
  financialYearStart: number,
  input: { concessionalCap: number | null; nonConcessionalCap: number | null },
): Promise<{ success: boolean; error?: string }> {
  const userId = await requireAuth();
  if (!userId) return { success: false, error: "Not authenticated" };
  if (!isValidFinancialYearStart(financialYearStart)) {
    return { success: false, error: "Choose a valid Australian financial year" };
  }
  const caps = [input.concessionalCap, input.nonConcessionalCap];
  if (caps.some((cap) => cap !== null && (!Number.isFinite(cap) || cap < 0))) {
    return { success: false, error: "Caps must be zero or greater" };
  }
  await db.insert(superContributionCaps).values({
    userId,
    financialYearStart,
    concessionalCap: input.concessionalCap?.toFixed(2) ?? null,
    nonConcessionalCap: input.nonConcessionalCap?.toFixed(2) ?? null,
  }).onConflictDoUpdate({
    target: [superContributionCaps.userId, superContributionCaps.financialYearStart],
    set: {
      concessionalCap: input.concessionalCap?.toFixed(2) ?? null,
      nonConcessionalCap: input.nonConcessionalCap?.toFixed(2) ?? null,
      updatedAt: new Date(),
    },
  });
  revalidateSuperPaths(userId);
  return { success: true };
}

export async function getSuperAccountDetails(accountId: string) {
  const userId = await requireAuth();
  if (!userId) return null;
  const record = await findOwnedSuperAccount(accountId, userId);
  if (!record) return null;
  const contributions = await db.query.superContributions.findMany({
    where: and(eq(superContributions.superAccountId, record.id), eq(superContributions.userId, userId)),
    orderBy: [desc(superContributions.date), desc(superContributions.createdAt)],
  });
  return { ...record, contributions };
}

export async function getSuperCapProgress(financialYearStart: number) {
  const userId = await requireAuth();
  if (!userId || !isValidFinancialYearStart(financialYearStart)) return null;
  const [configuration, contributions] = await Promise.all([
    db.query.superContributionCaps.findFirst({ where: and(eq(superContributionCaps.userId, userId), eq(superContributionCaps.financialYearStart, financialYearStart)) }),
    db.query.superContributions.findMany({ where: eq(superContributions.userId, userId) }),
  ]);
  const validContributions: SuperContributionForProgress[] = contributions.flatMap((contribution) => (
      isSuperContributionKind(contribution.kind)
        ? [{ date: contribution.date, amount: contribution.amount, kind: contribution.kind }]
        : []
    ));
  return calculateSuperCapProgress(
    validContributions,
    financialYearStart,
    configuration ?? null,
  );
}

export async function getSuperAccountMap(accountIds: string[]) {
  const userId = await requireAuth();
  if (!userId || accountIds.length === 0) return new Map<string, { includeInNetWorth: boolean }>();
  const rows = await db.query.superAccounts.findMany({
    where: and(eq(superAccounts.userId, userId), inArray(superAccounts.accountId, accountIds)),
  });
  return new Map(rows.map((row) => [row.accountId, { includeInNetWorth: row.includeInNetWorth }]));
}
