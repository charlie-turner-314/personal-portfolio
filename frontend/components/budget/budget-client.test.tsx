import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetClient } from "./budget-client";

const mocks = vi.hoisted(() => ({
  saveBudgetLines: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { info: mocks.toastInfo, success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/actions/budget", () => ({
  saveBudgetLines: mocks.saveBudgetLines,
}));

vi.mock("@/lib/actions/planned-expenses", () => ({
  createPlannedExpense: vi.fn(),
  deletePlannedExpense: vi.fn(),
  findTransactionsForPlannedExpense: vi.fn(),
  linkTransactionToPlannedExpense: vi.fn(),
  updatePlannedExpense: vi.fn(),
}));

const props = {
  data: {
    monthKey: "2026-04",
    currency: "USD",
    accountIds: [],
    totals: {
      plannedAmount: 150,
      actualAmount: 25,
      remainingAmount: 125,
      varianceAmount: -125,
      usedPct: 17,
      categoriesOverBudget: 0,
    },
    lines: [
      {
        categoryId: "food",
        categoryName: "Food",
        categoryColor: null,
        categoryIcon: null,
        plannedAmount: 150,
        actualAmount: 25,
        previousMonthActualAmount: 90.5,
        remainingAmount: 125,
        varianceAmount: -125,
        usedPct: 17,
        notes: null,
        insight: null,
      },
      {
        categoryId: "travel",
        categoryName: "Travel",
        categoryColor: null,
        categoryIcon: null,
        plannedAmount: 20,
        actualAmount: 0,
        previousMonthActualAmount: 0,
        remainingAmount: 20,
        varianceAmount: -20,
        usedPct: 0,
        notes: null,
        insight: null,
      },
    ],
  },
  accounts: [],
  plannedExpenses: {
    monthKey: "2026-04",
    currency: "USD",
    accountIds: [],
    totals: { monthlyProvision: 0, actualPaidThisMonth: 0, upcomingAmountThisMonth: 0, activeCount: 0 },
    items: [],
  },
  plannedExpenseOptions: { categories: [], accounts: [] },
};

describe("BudgetClient", () => {
  beforeEach(() => {
    mocks.saveBudgetLines.mockReset();
    mocks.toastInfo.mockReset();
  });

  it("right-aligns wrapped header actions", () => {
    render(<BudgetClient {...props} />);

    expect(screen.getByTestId("budget-actions")).toHaveClass("justify-end");
  });

  it("uses last month's category spending in editable planned amounts without saving", () => {
    render(<BudgetClient {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Use last month's spending" }));

    for (const input of screen.getAllByRole("spinbutton", { name: "Food planned amount" })) {
      expect(input).toHaveValue(90.5);
    }
    for (const input of screen.getAllByRole("spinbutton", { name: "Travel planned amount" })) {
      expect(input).toHaveValue(null);
    }
    expect(mocks.saveBudgetLines).not.toHaveBeenCalled();
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      "Last month's spending added to your plan. Save when you're ready."
    );
  });

  it("leaves the plan unchanged and explains when last month has no spending", () => {
    const noPreviousSpending = {
      ...props,
      data: {
        ...props.data,
        lines: props.data.lines.map((line) => ({ ...line, previousMonthActualAmount: 0 })),
      },
    };
    render(<BudgetClient {...noPreviousSpending} />);

    fireEvent.click(screen.getByRole("button", { name: "Use last month's spending" }));

    for (const input of screen.getAllByRole("spinbutton", { name: "Food planned amount" })) {
      expect(input).toHaveValue(150);
    }
    expect(mocks.saveBudgetLines).not.toHaveBeenCalled();
    expect(mocks.toastInfo).toHaveBeenCalledWith("No spending found last month");
  });
});
