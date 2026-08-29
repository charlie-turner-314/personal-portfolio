import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const insertValues: Record<string, unknown>[] = [];
  const updateSets: Record<string, unknown>[] = [];
  const db = {
    query: {
      superAccounts: { findFirst: vi.fn(), findMany: vi.fn() },
      superContributions: { findMany: vi.fn() },
      superContributionCaps: { findFirst: vi.fn() },
    },
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        insertValues.push(values);
        return {
          returning: vi.fn(async () => [{ id: "record-1" }]),
          onConflictDoNothing: vi.fn(async () => []),
          onConflictDoUpdate: vi.fn(async () => undefined),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateSets.push(values);
        return { where: vi.fn(async () => undefined) };
      }),
    })),
  };

  return {
    db,
    insertValues,
    updateSets,
    requireAuth: vi.fn(),
    revalidatePath: vi.fn(),
    updateTag: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/auth-helpers", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
  updateTag: mocks.updateTag,
}));

import {
  addSuperBalanceSnapshot,
  addSuperContribution,
  getSuperCapProgress,
  saveSuperContributionCaps,
} from "./superannuation";

const ownedSuperAccount = {
  id: "super-account-1",
  accountId: "account-1",
  userId: "user-1",
  account: { accountType: "superannuation", currency: "AUD" },
};

describe("superannuation actions", () => {
  beforeEach(() => {
    mocks.insertValues.length = 0;
    mocks.updateSets.length = 0;
    mocks.requireAuth.mockReset();
    mocks.db.insert.mockClear();
    mocks.db.update.mockClear();
    mocks.db.query.superAccounts.findFirst.mockReset();
    mocks.db.query.superContributions.findMany.mockReset();
    mocks.db.query.superContributionCaps.findFirst.mockReset();
  });

  it("requires an owned superannuation account before writing a contribution", async () => {
    mocks.requireAuth.mockResolvedValue("user-1");
    mocks.db.query.superAccounts.findFirst.mockResolvedValue(null);

    await expect(addSuperContribution("other-users-account", {
      date: "2025-07-01", amount: 100, kind: "employer_sg",
    })).resolves.toEqual({ success: false, error: "Super account not found" });
    expect(mocks.db.insert).not.toHaveBeenCalled();
  });

  it("rejects non-super accounts and invalid contribution inputs", async () => {
    mocks.requireAuth.mockResolvedValue("user-1");
    mocks.db.query.superAccounts.findFirst.mockResolvedValue({
      ...ownedSuperAccount,
      account: { accountType: "checking", currency: "AUD" },
    });
    await expect(addSuperContribution("account-1", {
      date: "2025-07-01", amount: 100, kind: "employer_sg",
    })).resolves.toEqual({ success: false, error: "Super account not found" });

    mocks.db.query.superAccounts.findFirst.mockResolvedValue(ownedSuperAccount);
    await expect(addSuperContribution("account-1", {
      date: "2025-02-30", amount: 0, kind: "not_a_kind" as never,
    })).resolves.toEqual({
      success: false,
      error: "Enter a valid date, positive amount, and contribution type",
    });
    expect(mocks.db.insert).not.toHaveBeenCalled();
  });

  it("creates immutable contribution records with a runtime-narrowed kind", async () => {
    mocks.requireAuth.mockResolvedValue("user-1");
    mocks.db.query.superAccounts.findFirst.mockResolvedValue(ownedSuperAccount);

    await expect(addSuperContribution("account-1", {
      date: "2025-07-01", amount: 1_234.5, kind: "salary_sacrifice", notes: "Payroll",
    })).resolves.toEqual({ success: true, contributionId: "record-1" });

    expect(mocks.insertValues).toEqual([expect.objectContaining({
      userId: "user-1",
      superAccountId: "super-account-1",
      date: "2025-07-01",
      amount: "1234.50",
      currency: "AUD",
      kind: "salary_sacrifice",
      notes: "Payroll",
    })]);
    expect(mocks.db.update).not.toHaveBeenCalled();
  });

  it("stores a manual balance snapshot only for an owned super account", async () => {
    mocks.requireAuth.mockResolvedValue("user-1");
    mocks.db.query.superAccounts.findFirst.mockResolvedValue(ownedSuperAccount);

    await expect(addSuperBalanceSnapshot("account-1", {
      date: "2025-07-01", balance: 99_000,
    })).resolves.toEqual({ success: true });

    expect(mocks.insertValues[0]).toEqual(expect.objectContaining({
      accountId: "account-1",
      balanceInAccountCurrency: "99000.00",
      balanceInFunctionalCurrency: "99000.00",
    }));
    expect(mocks.db.update).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid balance snapshots before writing history", async () => {
    mocks.requireAuth.mockResolvedValue("user-1");
    mocks.db.query.superAccounts.findFirst.mockResolvedValue(ownedSuperAccount);

    await expect(addSuperBalanceSnapshot("account-1", {
      date: "2025-02-30", balance: -1,
    })).resolves.toEqual({ success: false, error: "Enter a valid date and non-negative balance" });
    expect(mocks.db.insert).not.toHaveBeenCalled();
  });

  it("validates financial-year cap configuration before writing", async () => {
    mocks.requireAuth.mockResolvedValue("user-1");

    await expect(saveSuperContributionCaps(2025.5, {
      concessionalCap: 30_000, nonConcessionalCap: 120_000,
    })).resolves.toEqual({ success: false, error: "Choose a valid Australian financial year" });
    await expect(saveSuperContributionCaps(2025, {
      concessionalCap: -1, nonConcessionalCap: null,
    })).resolves.toEqual({ success: false, error: "Caps must be zero or greater" });
    expect(mocks.db.insert).not.toHaveBeenCalled();
  });

  it("ignores unknown persisted kinds before calculating cap progress", async () => {
    mocks.requireAuth.mockResolvedValue("user-1");
    mocks.db.query.superContributionCaps.findFirst.mockResolvedValue({
      concessionalCap: "30.00", nonConcessionalCap: null,
    });
    mocks.db.query.superContributions.findMany.mockResolvedValue([
      { date: "2025-07-01", amount: "10.00", kind: "employer_sg" },
      { date: "2025-07-02", amount: "999.00", kind: "unexpected_kind" },
    ]);

    await expect(getSuperCapProgress(2025)).resolves.toMatchObject({
      concessional: { used: 10, cap: 30, remaining: 20, configured: true },
      nonConcessional: { used: 0, cap: null, remaining: null, configured: false },
    });
  });

  it("returns no cap progress for an invalid financial year", async () => {
    mocks.requireAuth.mockResolvedValue("user-1");
    await expect(getSuperCapProgress(2025.5)).resolves.toBeNull();
    expect(mocks.db.query.superContributions.findMany).not.toHaveBeenCalled();
  });
});
