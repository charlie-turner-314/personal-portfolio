import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const insertValues: Record<string, unknown>[] = [];
  const updateResults: unknown[][] = [];
  const updateValues: Record<string, unknown>[] = [];
  const deleteResults: unknown[][] = [];

  const createSelectBuilder = (result: unknown[]) => {
    const builder = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
      groupBy: vi.fn(() => builder),
      limit: vi.fn(() => Promise.resolve(result)),
      then: vi.fn(
        (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject)
      ),
    };
    return builder;
  };

  const db = {
    select: vi.fn(() => createSelectBuilder(selectResults.shift() ?? [])),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        insertValues.push(values);
        return {
          onConflictDoUpdate: vi.fn(() => ({
            returning: vi.fn(async () => [{ id: "new-row" }]),
          })),
          returning: vi.fn(async () => [{ id: "new-row" }]),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateValues.push(values);
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => updateResults.shift() ?? []),
          })),
        };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => deleteResults.shift() ?? []),
      })),
    })),
  };

  return {
    db,
    selectResults,
    insertValues,
    updateResults,
    updateValues,
    deleteResults,
    requireAuth: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({
  db: mocks.db,
}));

vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: mocks.requireAuth,
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));

import {
  createCashflowOverride,
  deleteCashflowOverride,
  setRecurringScheduleOverride,
  updateCashflowOverride,
} from "./cashflow-forecast";

describe("cashflow forecast actions", () => {
  beforeEach(() => {
    mocks.selectResults.length = 0;
    mocks.insertValues.length = 0;
    mocks.updateResults.length = 0;
    mocks.updateValues.length = 0;
    mocks.deleteResults.length = 0;
    mocks.db.select.mockClear();
    mocks.db.insert.mockClear();
    mocks.db.update.mockClear();
    mocks.db.delete.mockClear();
    mocks.requireAuth.mockReset();
    mocks.revalidatePath.mockReset();
  });

  it("requires auth before creating a cashflow override", async () => {
    mocks.requireAuth.mockResolvedValue(null);

    const result = await createCashflowOverride({
      accountId: "account-1",
      expectedDate: "2026-09-01",
      direction: "income",
      amount: 1200,
      description: "Salary",
    });

    expect(result).toEqual({ success: false, error: "Not authenticated" });
    expect(mocks.db.select).not.toHaveBeenCalled();
  });

  it("validates override amount before ownership queries", async () => {
    mocks.requireAuth.mockResolvedValue("user-1");

    const result = await createCashflowOverride({
      accountId: "account-1",
      expectedDate: "2026-09-01",
      direction: "expense",
      amount: 0,
      description: "Rates",
    });

    expect(result).toEqual({ success: false, error: "Amount must be greater than zero" });
    expect(mocks.db.select).not.toHaveBeenCalled();
  });

  it("rejects overrides for accounts the user does not own", async () => {
    mocks.requireAuth.mockResolvedValue("user-1");
    mocks.selectResults.push([]);

    const result = await createCashflowOverride({
      accountId: "missing-account",
      expectedDate: "2026-09-01",
      direction: "expense",
      amount: 500,
      description: "Insurance",
    });

    expect(result).toEqual({ success: false, error: "Account could not be found" });
    expect(mocks.db.insert).not.toHaveBeenCalled();
  });

  it("creates a valid manual override and revalidates cashflow", async () => {
    mocks.requireAuth.mockResolvedValue("user-1");
    mocks.selectResults.push([{ id: "account-1" }]);

    const result = await createCashflowOverride({
      accountId: "account-1",
      categoryId: null,
      expectedDate: "2026-09-01",
      direction: "transfer_out",
      amount: 250.456,
      description: "Move to savings",
      notes: " temporary ",
    });

    expect(result).toEqual({ success: true, id: "new-row" });
    expect(mocks.insertValues[0]).toMatchObject({
      userId: "user-1",
      accountId: "account-1",
      categoryId: null,
      expectedDate: "2026-09-01",
      direction: "transfer_out",
      amount: "250.46",
      description: "Move to savings",
      notes: "temporary",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/cashflow");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/");
  });

  it("upserts recurring schedule overrides for owned recurring rows", async () => {
    mocks.requireAuth.mockResolvedValue("user-1");
    mocks.selectResults.push([{ id: "recurring-1" }]);

    const result = await setRecurringScheduleOverride({
      recurringTransactionId: "recurring-1",
      anchorDate: "2026-09-15",
      direction: "inflow",
    });

    expect(result).toEqual({ success: true, id: "new-row" });
    expect(mocks.insertValues[0]).toMatchObject({
      userId: "user-1",
      recurringTransactionId: "recurring-1",
      anchorDate: "2026-09-15",
      direction: "inflow",
    });
  });

  it("updates an owned manual override", async () => {
    mocks.requireAuth.mockResolvedValue("user-1");
    mocks.selectResults.push([{ id: "account-1" }]);
    mocks.updateResults.push([{ id: "override-1" }]);

    const result = await updateCashflowOverride("override-1", {
      accountId: "account-1",
      expectedDate: "2026-09-02",
      direction: "expense",
      amount: 50,
      description: "Updated bill",
    });

    expect(result).toEqual({ success: true, id: "override-1" });
    expect(mocks.updateValues[0]).toMatchObject({
      accountId: "account-1",
      expectedDate: "2026-09-02",
      direction: "expense",
      amount: "50.00",
      description: "Updated bill",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/cashflow");
  });

  it("does not report success when deleting a missing manual override", async () => {
    mocks.requireAuth.mockResolvedValue("user-1");
    mocks.deleteResults.push([]);

    const result = await deleteCashflowOverride("missing-override");

    expect(result).toEqual({
      success: false,
      error: "Cashflow override not found",
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
