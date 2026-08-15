import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  type QueryCall = {
    selection: unknown;
    chain: string[];
  };

  type TxOperation =
    | { type: "delete"; where: unknown }
    | { type: "insert"; values: Record<string, unknown>; conflict?: unknown };

  const queryResults = {
    categories: [] as unknown[],
    ownedCategories: [] as unknown[],
    budgetRows: [] as unknown[],
    currencyRows: [] as unknown[],
    sourceRows: [] as unknown[],
    futureRows: [] as unknown[],
  };
  const queryCalls: QueryCall[] = [];
  const txOperations: TxOperation[] = [];

  const resultForSelection = (selection: Record<string, unknown>) => {
    const keys = Object.keys(selection);

    if (keys.includes("functionalCurrency")) {
      return queryResults.currencyRows;
    }
    if (keys.includes("month")) {
      return queryResults.futureRows;
    }
    if (keys.includes("name")) {
      return queryResults.categories;
    }
    if (keys.includes("plannedAmount")) {
      return queryResults.sourceRows.length > 0
        ? queryResults.sourceRows
        : queryResults.budgetRows;
    }
    if (keys.length === 1 && keys[0] === "id") {
      return queryResults.ownedCategories;
    }

    return [];
  };

  const createSelectBuilder = (selection: unknown, result: unknown[]) => {
    const call: QueryCall = { selection, chain: [] };
    queryCalls.push(call);

    const builder = {
      from: vi.fn(() => {
        call.chain.push("from");
        return builder;
      }),
      innerJoin: vi.fn(() => {
        call.chain.push("innerJoin");
        return builder;
      }),
      leftJoin: vi.fn(() => {
        call.chain.push("leftJoin");
        return builder;
      }),
      where: vi.fn(() => {
        call.chain.push("where");
        return builder;
      }),
      orderBy: vi.fn(() => {
        call.chain.push("orderBy");
        return builder;
      }),
      groupBy: vi.fn(() => {
        call.chain.push("groupBy");
        return builder;
      }),
      limit: vi.fn(() => {
        call.chain.push("limit");
        return builder;
      }),
      then: vi.fn(
        (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject)
      ),
    };

    return builder;
  };

  const createDeleteBuilder = () => ({
    where: vi.fn(async (where: unknown) => {
      txOperations.push({ type: "delete", where });
    }),
  });

  const createInsertBuilder = () => ({
    values: vi.fn((values: Record<string, unknown>) => {
      const operation: TxOperation = { type: "insert", values };
      txOperations.push(operation);

      return {
        onConflictDoUpdate: vi.fn(async (conflict: unknown) => {
          operation.conflict = conflict;
        }),
      };
    }),
  });

  const db = {
    select: vi.fn((selection: unknown) =>
      createSelectBuilder(selection, resultForSelection(selection as Record<string, unknown>))
    ),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      return callback({
        select: vi.fn((selection: unknown) =>
          createSelectBuilder(selection, resultForSelection(selection as Record<string, unknown>))
        ),
        delete: vi.fn(() => createDeleteBuilder()),
        insert: vi.fn(() => createInsertBuilder()),
      });
    }),
  };

  return {
    db,
    queryResults,
    queryCalls,
    txOperations,
    requireAuth: vi.fn(),
    revalidatePath: vi.fn(),
    fetchCategoryActualAmounts: vi.fn(),
    fetchBudgetInsights: vi.fn(),
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

vi.mock("@/lib/spending/category-actuals", () => ({
  fetchCategoryActualAmounts: mocks.fetchCategoryActualAmounts,
}));

vi.mock("@/lib/spending/budget-insights", () => ({
  fetchBudgetInsights: mocks.fetchBudgetInsights,
}));

import {
  applyBudgetToFutureMonths,
  getBudgetData,
  previewFutureBudgetPlan,
  saveBudgetLines,
} from "./budget";

describe("budget actions", () => {
  beforeEach(() => {
    mocks.queryResults.categories = [];
    mocks.queryResults.ownedCategories = [];
    mocks.queryResults.budgetRows = [];
    mocks.queryResults.currencyRows = [];
    mocks.queryResults.sourceRows = [];
    mocks.queryResults.futureRows = [];
    mocks.queryCalls.length = 0;
    mocks.txOperations.length = 0;
    mocks.db.select.mockClear();
    mocks.db.transaction.mockClear();
    mocks.requireAuth.mockReset();
    mocks.revalidatePath.mockReset();
    mocks.fetchCategoryActualAmounts.mockReset();
    mocks.fetchBudgetInsights.mockReset();
  });

  afterEach(() => vi.useRealTimers());

  describe("saveBudgetLines", () => {
    it("rejects categories that are invalid or not owned by the user", async () => {
      mocks.requireAuth.mockResolvedValue("user-1");
      mocks.queryResults.ownedCategories = [{ id: "category-owned" }];

      const result = await saveBudgetLines("2026-04", [
        { categoryId: "category-owned", plannedAmount: 120 },
        { categoryId: "category-missing", plannedAmount: 50 },
      ]);

      expect(result).toEqual({
        success: false,
        error: "One or more budget categories could not be found",
      });
      expect(mocks.db.transaction).not.toHaveBeenCalled();
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    });

    it("deletes existing rows when planned amount is zero and notes are empty", async () => {
      mocks.requireAuth.mockResolvedValue("user-1");
      mocks.queryResults.ownedCategories = [{ id: "category-food" }];

      const result = await saveBudgetLines("2026-04", [
        { categoryId: "category-food", plannedAmount: 0, notes: "   " },
      ]);

      expect(result).toEqual({ success: true });
      expect(mocks.txOperations).toHaveLength(1);
      expect(mocks.txOperations[0]).toMatchObject({ type: "delete" });
      expect(mocks.revalidatePath).toHaveBeenCalledWith("/budget");
      expect(mocks.revalidatePath).toHaveBeenCalledWith("/");
    });

    it("upserts valid positive amounts and trims notes", async () => {
      mocks.requireAuth.mockResolvedValue("user-1");
      mocks.queryResults.ownedCategories = [
        { id: "category-food" },
        { id: "category-rent" },
      ];

      const result = await saveBudgetLines("2026-04", [
        { categoryId: "category-food", plannedAmount: 123.456, notes: " weekly groceries " },
        { categoryId: "category-rent", plannedAmount: 1000, notes: "\nflat rent\t" },
      ]);

      expect(result).toEqual({ success: true });
      expect(mocks.txOperations).toHaveLength(2);
      expect(mocks.txOperations[0]).toMatchObject({
        type: "insert",
        values: {
          userId: "user-1",
          categoryId: "category-food",
          month: "2026-04-01",
          plannedAmount: "123.46",
          notes: "weekly groceries",
        },
      });
      expect(mocks.txOperations[1]).toMatchObject({
        type: "insert",
        values: {
          userId: "user-1",
          categoryId: "category-rent",
          month: "2026-04-01",
          plannedAmount: "1000.00",
          notes: "flat rent",
        },
      });
      expect(
        mocks.txOperations.every(
          (operation) => operation.type === "insert" && operation.conflict
        )
      ).toBe(true);
    });
  });

  it("getBudgetData returns an empty budget when the user has no expense categories", async () => {
    mocks.requireAuth.mockResolvedValue("user-1");
    mocks.queryResults.currencyRows = [{ functionalCurrency: "AUD" }];
    mocks.fetchCategoryActualAmounts.mockResolvedValue([]);
    mocks.fetchBudgetInsights.mockResolvedValue([]);

    await expect(getBudgetData("2026-04")).resolves.toEqual({
      monthKey: "2026-04",
      currency: "AUD",
      accountIds: [],
      totals: {
        plannedAmount: 0,
        actualAmount: 0,
        remainingAmount: 0,
        varianceAmount: 0,
        usedPct: 0,
        categoriesOverBudget: 0,
      },
      lines: [],
    });
  });

  it("getBudgetData maps category, budget, and actual rows into month totals", async () => {
    mocks.requireAuth.mockResolvedValue("user-1");
    mocks.queryResults.categories = [
      { id: "category-food", name: "Food", color: "#ff0000", icon: "restaurant" },
      { id: "category-rent", name: "Rent", color: null, icon: null },
      { id: "category-travel", name: "Travel", color: "#00ff00", icon: "plane" },
    ];
    mocks.queryResults.budgetRows = [
      { categoryId: "category-food", plannedAmount: "200.00", notes: "groceries" },
      { categoryId: "category-rent", plannedAmount: 1000, notes: null },
    ];
    mocks.queryResults.currencyRows = [{ functionalCurrency: "USD" }];
    mocks.fetchCategoryActualAmounts
      .mockResolvedValueOnce([
        { id: "category-food", amount: "250.25" },
        { id: "category-rent", amount: "750.10" },
        { id: "category-ignored", amount: "999.00" },
      ])
      .mockResolvedValueOnce([
        { id: "category-food", amount: "180.45" },
        { id: "category-travel", amount: "50.00" },
      ]);
    mocks.fetchBudgetInsights.mockResolvedValue([
      {
        categoryId: "category-food",
        categoryName: "Food",
        plannedAmount: 200,
        actualAmount: 250.25,
        overspendAmount: 50.25,
        previousMonthAmount: 100,
        previousThreeMonthAverage: 150,
        sameMonthLastYearAmount: null,
        driverType: "one_off",
        explanation: "Food is over budget.",
        topMerchants: [],
        topTransactions: [],
      },
    ]);

    const data = await getBudgetData("2026-04", {
      accountIds: [" account-1 ", "account-1", "account-2"],
    });

    expect(mocks.fetchCategoryActualAmounts).toHaveBeenCalledWith("user-1", {
      startDate: new Date(2026, 3, 1),
      endDate: new Date(2026, 3, 30, 23, 59, 59, 999),
      accountIds: ["account-1", "account-2"],
      includeUncategorized: false,
    });
    expect(mocks.fetchCategoryActualAmounts).toHaveBeenCalledWith("user-1", {
      startDate: new Date(2026, 2, 1),
      endDate: new Date(2026, 2, 31, 23, 59, 59, 999),
      accountIds: ["account-1", "account-2"],
      includeUncategorized: false,
    });
    expect(mocks.fetchBudgetInsights).toHaveBeenCalledWith("user-1", {
      monthKey: "2026-04",
      startDate: new Date(2026, 3, 1),
      endDate: new Date(2026, 3, 30, 23, 59, 59, 999),
      accountIds: ["account-1", "account-2"],
      categories: [
        {
          categoryId: "category-food",
          categoryName: "Food",
          plannedAmount: 200,
          actualAmount: 250.25,
          overspendAmount: 50.25,
        },
      ],
    });
    expect(data).toEqual({
      monthKey: "2026-04",
      currency: "USD",
      accountIds: ["account-1", "account-2"],
      totals: {
        plannedAmount: 1200,
        actualAmount: 1000.35,
        remainingAmount: 199.65,
        varianceAmount: -199.65,
        usedPct: 83,
        categoriesOverBudget: 1,
      },
      lines: [
        {
          categoryId: "category-food",
          categoryName: "Food",
          categoryColor: "#ff0000",
          categoryIcon: "restaurant",
          plannedAmount: 200,
          actualAmount: 250.25,
          previousMonthActualAmount: 180.45,
          remainingAmount: -50.25,
          varianceAmount: 50.25,
          usedPct: 125,
          notes: "groceries",
          insight: {
            categoryId: "category-food",
            categoryName: "Food",
            plannedAmount: 200,
            actualAmount: 250.25,
            overspendAmount: 50.25,
            previousMonthAmount: 100,
            previousThreeMonthAverage: 150,
            sameMonthLastYearAmount: null,
            driverType: "one_off",
            explanation: "Food is over budget.",
            topMerchants: [],
            topTransactions: [],
          },
        },
        {
          categoryId: "category-rent",
          categoryName: "Rent",
          categoryColor: null,
          categoryIcon: null,
          plannedAmount: 1000,
          actualAmount: 750.1,
          previousMonthActualAmount: 0,
          remainingAmount: 249.9,
          varianceAmount: -249.9,
          usedPct: 75,
          notes: null,
          insight: null,
        },
        {
          categoryId: "category-travel",
          categoryName: "Travel",
          categoryColor: "#00ff00",
          categoryIcon: "plane",
          plannedAmount: 0,
          actualAmount: 0,
          previousMonthActualAmount: 50,
          remainingAmount: 0,
          varianceAmount: 0,
          usedPct: 0,
          notes: null,
          insight: null,
        },
      ],
    });
  });

  describe("future budget plans", () => {
    it("previews the exact forward range and existing target months without writing", async () => {
      mocks.requireAuth.mockResolvedValue("user-1");
      mocks.queryResults.futureRows = [
        { month: "2026-05-01" },
        { month: "2026-05-01" },
        { month: "2026-07-01" },
      ];
      await expect(previewFutureBudgetPlan("2026-04", 3)).resolves.toEqual({
        success: true,
        preview: { startMonthKey: "2026-05", endMonthKey: "2026-07", monthCount: 3, existingMonthCount: 2 },
      });
      expect(mocks.db.transaction).not.toHaveBeenCalled();
    });

    it("rejects invalid, unauthenticated, and historical plans before writing", async () => {
      mocks.requireAuth.mockResolvedValue(null);
      await expect(previewFutureBudgetPlan("2026-04", 3)).resolves.toEqual({ success: false, error: "Not authenticated" });
      mocks.requireAuth.mockResolvedValue("user-1");
      await expect(applyBudgetToFutureMonths("2026-04", 0, [])).resolves.toEqual({ success: false, error: "Choose between 1 and 12 months" });
      vi.setSystemTime(new Date("2026-08-16T12:00:00Z"));
      await expect(previewFutureBudgetPlan("2026-04", 3)).resolves.toEqual({ success: false, error: "Choose the current month or a future month to apply a budget forward" });
      expect(mocks.db.transaction).not.toHaveBeenCalled();
    });

    it("requires confirmation before replacing existing future budgets", async () => {
      mocks.requireAuth.mockResolvedValue("user-1");
      mocks.queryResults.ownedCategories = [{ id: "category-food" }];
      mocks.queryResults.futureRows = [{ month: "2026-05-01" }];
      await expect(applyBudgetToFutureMonths("2026-04", 1, [{ categoryId: "category-food", plannedAmount: 50 }])).resolves.toEqual({
        success: false,
        requiresConfirmation: true,
        preview: { startMonthKey: "2026-05", endMonthKey: "2026-05", monthCount: 1, existingMonthCount: 1 },
      });
      expect(mocks.txOperations).toHaveLength(0);
    });

    it("copies only planned amounts into future months atomically", async () => {
      mocks.requireAuth.mockResolvedValue("user-1");
      mocks.queryResults.ownedCategories = [{ id: "category-food" }];
      await expect(applyBudgetToFutureMonths("2026-12", 2, [{ categoryId: "category-food", plannedAmount: 123.456 }], true)).resolves.toMatchObject({ success: true, appliedMonthCount: 2 });
      expect(mocks.txOperations).toHaveLength(4);
      expect(mocks.txOperations).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "insert", values: expect.objectContaining({ month: "2027-01-01", plannedAmount: "123.46", notes: null }) }),
        expect.objectContaining({ type: "insert", values: expect.objectContaining({ month: "2027-02-01" }) }),
      ]));
    });
  });
});
