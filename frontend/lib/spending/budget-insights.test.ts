import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {},
}));

import {
  buildBudgetInsightExplanation,
  resolveBudgetVarianceDriver,
} from "@/lib/spending/budget-insights";

const transaction = (
  amount: number,
  isRecurring = false
) => ({
  amount,
  isRecurring,
});

describe("buildBudgetInsightExplanation", () => {
  it("describes one-off overspend with merchant and comparison context", () => {
    const explanation = buildBudgetInsightExplanation({
      categoryName: "Groceries",
      plannedAmount: 500,
      actualAmount: 680,
      overspendAmount: 180,
      previousThreeMonthAverage: 520,
      sameMonthLastYearAmount: 450,
      driverType: "one_off",
      topMerchants: [{ name: "Woolworths", amount: 220, transactionCount: 2 }],
    });

    expect(explanation).toContain("Groceries is 136% of plan");
    expect(explanation).toContain("mostly from one-off spending");
    expect(explanation).toContain("led by Woolworths");
    expect(explanation).toContain("above the prior 3-month average");
    expect(explanation).toContain("above the same month last year");
  });

  it("describes recurring overspend without year comparison when no prior-year data exists", () => {
    const explanation = buildBudgetInsightExplanation({
      categoryName: "Subscriptions",
      plannedAmount: 100,
      actualAmount: 180,
      overspendAmount: 80,
      previousThreeMonthAverage: 170,
      sameMonthLastYearAmount: null,
      driverType: "recurring",
      topMerchants: [],
    });

    expect(explanation).toContain("mostly from recurring spend");
    expect(explanation).not.toContain("same month last year");
  });
});

describe("resolveBudgetVarianceDriver", () => {
  it("classifies a large individual non-recurring transaction as one-off", () => {
    expect(
      resolveBudgetVarianceDriver(120, [
        transaction(160),
        transaction(45, true),
        transaction(35, true),
      ])
    ).toBe("one_off");
  });

  it("classifies recurring spend when deterministic recurring rows dominate", () => {
    expect(
      resolveBudgetVarianceDriver(100, [
        transaction(70, true),
        transaction(65, true),
        transaction(30, true),
        transaction(35),
      ])
    ).toBe("recurring");
  });

  it("classifies mixed spend when neither recurring nor one-off spend dominates", () => {
    expect(
      resolveBudgetVarianceDriver(120, [
        transaction(70, true),
        transaction(55, true),
        transaction(45),
        transaction(40),
      ])
    ).toBe("mixed");
  });
});
