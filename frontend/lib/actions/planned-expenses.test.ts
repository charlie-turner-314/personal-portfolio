import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const insertValues: Record<string, unknown>[] = [];

  const createSelectBuilder = (result: unknown[]) => {
    const builder = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
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
          returning: vi.fn(async () => [{ id: "new-link" }]),
        };
      }),
    })),
  };

  return {
    db,
    selectResults,
    insertValues,
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
  createPlannedExpense,
  linkTransactionToPlannedExpense,
} from "./planned-expenses";

describe("planned expense actions", () => {
  beforeEach(() => {
    mocks.selectResults.length = 0;
    mocks.insertValues.length = 0;
    mocks.db.select.mockClear();
    mocks.db.insert.mockClear();
    mocks.requireAuth.mockReset();
    mocks.revalidatePath.mockReset();
  });

  it("requires auth before creating planned expenses", async () => {
    mocks.requireAuth.mockResolvedValue(null);

    const result = await createPlannedExpense({
      name: "Insurance",
      amount: 1200,
      categoryId: "category-1",
      accountId: "account-1",
      dueDate: "2026-12-01",
      recurrenceType: "annual",
    });

    expect(result).toEqual({ success: false, error: "Not authenticated" });
    expect(mocks.db.select).not.toHaveBeenCalled();
  });

  it("validates custom recurrence intervals before writing", async () => {
    mocks.requireAuth.mockResolvedValue("user-1");

    const result = await createPlannedExpense({
      name: "School fees",
      amount: 900,
      categoryId: "category-1",
      accountId: "account-1",
      dueDate: "2026-09-01",
      recurrenceType: "custom",
      customIntervalMonths: 0,
    });

    expect(result).toEqual({
      success: false,
      error: "Custom interval must be between 1 and 120 months",
    });
    expect(mocks.db.select).not.toHaveBeenCalled();
  });

  it("rejects non-debit transactions when linking paid transactions", async () => {
    mocks.requireAuth.mockResolvedValue("user-1");
    mocks.selectResults.push(
      [{ id: "expense-1", accountId: "account-1" }],
      [
        {
          id: "transaction-1",
          accountId: "account-1",
          transactionType: "credit",
          amount: "500.00",
          functionalAmount: null,
          includeInAnalytics: true,
          internalTransferId: null,
        },
      ]
    );

    const result = await linkTransactionToPlannedExpense({
      plannedExpenseId: "expense-1",
      transactionId: "transaction-1",
      occurrenceDueDate: "2026-12-01",
    });

    expect(result).toEqual({
      success: false,
      error: "Only debit transactions can be linked",
    });
    expect(mocks.db.insert).not.toHaveBeenCalled();
  });

  it("links an owned debit transaction with the functional amount", async () => {
    mocks.requireAuth.mockResolvedValue("user-1");
    mocks.selectResults.push(
      [{ id: "expense-1", accountId: "account-1" }],
      [
        {
          id: "transaction-1",
          accountId: "account-1",
          transactionType: "debit",
          amount: "-100.00",
          functionalAmount: "-150.50",
          includeInAnalytics: true,
          internalTransferId: null,
        },
      ],
      []
    );

    const result = await linkTransactionToPlannedExpense({
      plannedExpenseId: "expense-1",
      transactionId: "transaction-1",
      occurrenceDueDate: "2026-12-01",
    });

    expect(result).toEqual({ success: true, id: "new-link" });
    expect(mocks.insertValues[0]).toMatchObject({
      userId: "user-1",
      plannedExpenseId: "expense-1",
      transactionId: "transaction-1",
      occurrenceDueDate: "2026-12-01",
      amountApplied: "150.50",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/budget");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/");
  });
});
