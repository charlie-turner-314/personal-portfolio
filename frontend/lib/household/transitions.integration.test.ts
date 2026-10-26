// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";
import { accountAccess } from "./account-access";
import { categoryAccess, categorySelectionHidden } from "./category-access";

const actionActor = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/household/financial-auth", () => ({ requireAuth: async () => actionActor.id }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/data/cached", () => ({ getCachedUserCategories: async () => [], CACHE_TAGS: { categories: (id: string) => `categories:${id}` } }));

const url = process.env.HOUSEHOLD_MODEL_TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let transitions: typeof import("./transitions");
let invitations: typeof import("./invitations");
let sharing: typeof import("./sharing");
const suffix = randomUUID();
const admin = `hfm-admin-${suffix}`, member = `hfm-member-${suffix}`, outsider = `hfm-outsider-${suffix}`;
const userIds = [admin, member, outsider];
const adminPerson = randomUUID(), memberPerson = randomUUID(), placeholder = randomUUID();
const destinationPerson = randomUUID();
const joint = randomUUID(), privateAdmin = randomUUID(), privateMember = randomUUID();
const principal = randomUUID(), consumption = randomUUID();
const transferId = randomUUID();
const accessible = async (actor: string) => (await db.select({ id: schema.accounts.id }).from(schema.accounts)
  .where(and(inArray(schema.accounts.id, [joint, privateAdmin, privateMember]), accountAccess(schema.accounts.id, actor)))).map(row => row.id).sort();
const definitions = async (actor: string) => (await db.select({ id: schema.categories.id }).from(schema.categories)
  .where(and(inArray(schema.categories.id, [principal, consumption]), categoryAccess(actor)))).map(row => row.id).sort();

beforeAll(async () => {
  if (!url) return;
  if (process.env.HOUSEHOLD_TEST_ISOLATED !== "yes" || !new URL(url).pathname.includes("household_model_test")) throw new Error("Use a dedicated synthetic household_model_test database");
  process.env.DATABASE_URL = url;
  process.env.BETTER_AUTH_SECRET = "synthetic-household-transition-signing-key";
  ({ db } = await import("@/lib/db"));
  transitions = await import("./transitions");
  invitations = await import("./invitations");
  sharing = await import("./sharing");
  await db.insert(schema.users).values(userIds.map((id, i) => ({ id, email: `${i}-${suffix}@example.test`, name: ["Admin", "Member", "Outsider"][i], functionalCurrency: "AUD" })));
  await db.insert(schema.people).values([
    { id: adminPerson, userId: admin, name: "Admin", kind: "self" },
    { id: memberPerson, userId: member, name: "Member", kind: "self" },
    { id: placeholder, userId: admin, name: "Partner", kind: "member" },
    { id: destinationPerson, userId: outsider, name: "Incoming member", kind: "member" },
  ]);
  await db.insert(schema.accounts).values([
    { id: joint, userId: admin, name: "Joint cash", accountType: "checking", currency: "AUD" },
    { id: privateAdmin, userId: admin, name: "Admin private", accountType: "checking", currency: "AUD" },
    { id: privateMember, userId: member, name: "Member private", accountType: "checking", currency: "AUD" },
  ]);
  await db.insert(schema.categories).values([
    { id: principal, userId: admin, name: "Housing", categoryType: "expense", cashFlowKind: "loan_principal", categorizationInstructions: "ADMIN SECRET" },
    { id: consumption, userId: member, name: "Housing", categoryType: "expense", categorizationInstructions: "MEMBER SECRET" },
  ]);
  await db.insert(schema.transactions).values({ id: transferId, userId: admin, accountId: joint, amount: "70000", currency: "AUD", bookedAt: new Date("2026-10-01T00:00:00Z"), categoryId: principal, cashFlowParts: [{ kind: "capital", detail: "loan_principal", amount: 70000 }] });
  await db.insert(schema.accountOwnershipAllocations).values([
    { accountId: joint, personId: adminPerson, effectiveFrom: "2026-01-01", share: "0.5" },
    { accountId: joint, personId: placeholder, effectiveFrom: "2026-01-01", share: "0.5" },
  ]);
});

afterAll(async () => {
  if (!url || !db) return;
  // Only this suite's synthetic rows; never reset a database or delete a volume.
  await db.delete(schema.categoryVocabularyEntries).where(inArray(schema.categoryVocabularyEntries.categoryId, [principal, consumption]));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
});

describe.skipIf(!url)("household lifecycle over a migrated PostgreSQL database", () => {
  it("repeats migration without financial rewrites or inferred grants", async () => {
    const before = await db.select().from(schema.transactions).where(eq(schema.transactions.id, transferId));
    const client = postgres(url!, { prepare: false });
    try {
      const migration = readFileSync("lib/db/migrations/0055_household_transition_audit.manual.sql", "utf8");
      await client.unsafe(migration);
      const entries = await db.select().from(schema.categoryVocabularyEntries).where(inArray(schema.categoryVocabularyEntries.categoryId, [principal, consumption]));
      await client.unsafe(migration);
      expect(await db.select().from(schema.transactions).where(eq(schema.transactions.id, transferId))).toEqual(before);
      expect(await db.select().from(schema.categoryVocabularyEntries).where(inArray(schema.categoryVocabularyEntries.categoryId, [principal, consumption]))).toHaveLength(entries.length);
      expect(await accessible(member)).toEqual([privateMember]);
      expect(await definitions(member)).toEqual([consumption]);
    } finally { await client.end(); }
  });

  it("recovers from a failed mapping after new writes without rolling back financial history", async () => {
    const postUpgradeId = randomUUID();
    await db.insert(schema.transactions).values({ id: postUpgradeId, userId: admin, accountId: joint,
      amount: "-123.45", currency: "AUD", bookedAt: new Date("2026-10-02T00:00:00Z"), categoryId: consumption });
    const before = await db.select().from(schema.transactions).where(eq(schema.transactions.id, postUpgradeId));
    const entriesBefore = await db.select().from(schema.categoryVocabularyEntries)
      .where(inArray(schema.categoryVocabularyEntries.categoryId, [principal, consumption]));
    const client = postgres(url!, { prepare: false });
    const migration = readFileSync("lib/db/migrations/0055_household_transition_audit.manual.sql", "utf8");
    try {
      await expect(client.begin(async tx => {
        await tx`DELETE FROM category_vocabulary_entries WHERE category_id IN (${principal},${consumption})`;
        await tx.unsafe(migration);
        throw new Error("injected migration failure");
      })).rejects.toThrow("injected migration failure");
      expect(await db.select().from(schema.categoryVocabularyEntries)
        .where(inArray(schema.categoryVocabularyEntries.categoryId, [principal, consumption]))).toEqual(entriesBefore);
      await client.unsafe(migration);
      await client.unsafe(migration);
      expect(await db.select().from(schema.transactions).where(eq(schema.transactions.id, postUpgradeId))).toEqual(before);
      // Keep the lifecycle fixture's one-record history deterministic.
      await db.delete(schema.transactions).where(eq(schema.transactions.id, postUpgradeId));
    } finally { await client.end(); }
  });

  it("joins privately, previews history and conflicts, rejects stale consent, rolls back failure, and shares explicitly", async () => {
    const invitation = await invitations.createHouseholdInvitation(admin, placeholder, `1-${suffix}@example.test`);
    const request = { action: "accept" as const, token: invitation.token };
    const review = await transitions.previewHouseholdTransition(member, request);
    expect(review.preview.accounts.map(account => account.id)).toEqual([privateMember]);
    expect(review.preview.categoryConflicts.map(category => category.id).sort()).toEqual([principal, consumption].sort());
    expect(JSON.stringify(review)).not.toContain("SECRET");
    await transitions.confirmHouseholdTransition(member, request, review.confirmation, () => invitations.acceptHouseholdInvitation(member, invitation.token));
    expect(await accessible(member)).toEqual([privateMember]);
    expect(await definitions(member)).toEqual([principal, consumption].sort());
    const share = { action: "share-account" as const, accountId: joint, memberUserIds: [member] };
    const old = await transitions.previewHouseholdTransition(admin, share);
    expect(old.preview.accounts[0]).toMatchObject({ recordCount: 1, firstRecord: expect.stringContaining("2026-10-01") });
    await expect(transitions.previewHouseholdTransition(outsider, share)).rejects.toThrow(/custodian/);
    await sharing.setAccountSharing(admin, joint, [member]);
    await expect(transitions.confirmHouseholdTransition(admin, share, old.confirmation, async () => undefined)).rejects.toThrow(/stale/);
    await sharing.setAccountSharing(admin, joint, []);
    const current = await transitions.previewHouseholdTransition(admin, share);
    await expect(transitions.confirmHouseholdTransition(admin, share, current.confirmation, async () => {
      await sharing.setAccountSharing(admin, joint, [member]);
      throw new Error("injected failure");
    })).rejects.toThrow("injected failure");
    expect(await accessible(member)).toEqual([privateMember]);
    await transitions.confirmHouseholdTransition(admin, share, current.confirmation, () => sharing.setAccountSharing(admin, joint, [member]));
    expect(await accessible(member)).toEqual([joint, privateMember].sort());
    expect(await accessible(outsider)).toEqual([]);
  });

  it("withdraws access, preserves vocabulary and ownership across leave/rejoin/move, and dissolves without orphans", async () => {
    const ownershipBefore = await db.select().from(schema.accountOwnershipAllocations).where(eq(schema.accountOwnershipAllocations.accountId, joint));
    const withdraw = { action: "share-account" as const, accountId: joint, memberUserIds: [] };
    const review = await transitions.previewHouseholdTransition(admin, withdraw);
    expect(review.preview.revokedRecipients).toEqual([member]);
    await transitions.confirmHouseholdTransition(admin, withdraw, review.confirmation, () => sharing.setAccountSharing(admin, joint, []));
    expect(await accessible(member)).toEqual([privateMember]);
    await sharing.setAccountSharing(admin, joint, [member]);
    const leave = { action: "leave" as const };
    const leaving = await transitions.previewHouseholdTransition(member, leave);
    await transitions.confirmHouseholdTransition(member, leave, leaving.confirmation, () => invitations.leaveHousehold(member));
    expect(await accessible(member)).toEqual([privateMember]);
    expect(await definitions(member)).toEqual([principal, consumption].sort());
    expect(await definitions(admin)).toEqual([principal, consumption].sort());
    const invitation = await invitations.createHouseholdInvitation(admin, placeholder, `1-${suffix}@example.test`);
    await invitations.acceptHouseholdInvitation(member, invitation.token);
    expect(await accessible(member)).toEqual([privateMember]);
    expect((await db.select().from(schema.people).where(eq(schema.people.id, placeholder)))[0].linkedUserId).toBe(member);
    await invitations.leaveHousehold(member);
    const destination = await invitations.createHouseholdInvitation(outsider, destinationPerson, `1-${suffix}@example.test`);
    await invitations.acceptHouseholdInvitation(member, destination.token);
    await sharing.setAccountSharing(member, privateMember, [outsider]);
    expect(await accessible(outsider)).toEqual([privateMember]);
    const dissolve = { action: "dissolve" as const };
    const ending = await transitions.previewHouseholdTransition(outsider, dissolve);
    await transitions.confirmHouseholdTransition(outsider, dissolve, ending.confirmation, () => invitations.dissolveHousehold(outsider));
    expect(await accessible(outsider)).toEqual([]);
    expect(await accessible(member)).toEqual([privateMember]);
    expect(await db.select().from(schema.accountOwnershipAllocations).where(eq(schema.accountOwnershipAllocations.accountId, joint))).toEqual(ownershipBefore);
    expect((await db.select().from(schema.accounts).where(inArray(schema.accounts.id, [joint, privateAdmin, privateMember])))).toHaveLength(3);
    expect((await db.select().from(schema.householdTransitionEvents).where(inArray(schema.householdTransitionEvents.actorUserId, userIds))).length).toBeGreaterThanOrEqual(5);
  });
  it("separates applying vocabulary from management and retires without losing references", async () => {
    const actions = await import("@/lib/actions/categories");
    actionActor.id = outsider;
    expect(await actions.deleteCategory(principal)).toMatchObject({ success: false });
    actionActor.id = admin;
    expect(await actions.deleteCategoryWithReassignment(principal, consumption)).toMatchObject({ success: false });
    const before = await db.select().from(schema.transactions).where(eq(schema.transactions.id, transferId));
    expect(await actions.deleteCategory(principal)).toMatchObject({ success: true, reassignedCount: 0 });
    expect(await db.select().from(schema.transactions).where(eq(schema.transactions.id, transferId))).toEqual(before);
    expect((await db.select().from(schema.categories).where(eq(schema.categories.id, principal)))[0].hideFromSelection).toBe(true);
    expect(await definitions(member)).toContain(principal);
    expect(await actions.updateCategory(principal,{cashFlowKind:"investment"})).toMatchObject({success:false});
    actionActor.id = member;
    const retained = (await actions.getCategoriesByType("expense")).find(category=>category.id===principal);
    expect(retained).toMatchObject({hideFromSelection:false,categorizationInstructions:null});
    actionActor.id = admin;
    const retired = (await actions.getCategoriesByType("expense")).find(category=>category.id===principal);
    expect(retired?.hideFromSelection).toBe(true);
  });

});
