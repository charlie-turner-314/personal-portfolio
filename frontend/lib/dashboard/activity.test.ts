import { describe, expect, it } from "vitest";
import { summarizeActivity, activitySankey, type ActivityRow } from "./activity";

const row = (amount: number, extra: Partial<ActivityRow> = {}): ActivityRow => ({
  date: "2026-10-14", amount, categoryId: null, categoryName: null,
  categoryType: null, icon: null, color: null, ...extra,
});

describe("dashboard activity", () => {
  it("includes uncategorized activity in totals, daily series and category totals", () => {
    const result = summarizeActivity([
      row(1000), row(-120), row(-80, { date: "2026-10-13" }),
      row(-50, { categoryId: "food", categoryName: "Food", categoryType: "expense" }),
    ]);
    expect(result.income).toBe(1000);
    expect(result.expenses).toBe(250);
    expect(result.dailyData).toEqual([
      { date: "2026-10-13", income: 0, expenses: 80 },
      { date: "2026-10-14", income: 1000, expenses: 170 },
    ]);
    expect(result.categories.filter((category) => category.type === "expense")
      .reduce((sum, category) => sum + category.amount, 0)).toBe(result.expenses);
    const sankey = activitySankey(result);
    expect(sankey.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Uncategorized income", total: 1000 }),
      expect.objectContaining({ name: "Uncategorized expenses", total: 200 }),
      expect.objectContaining({ name: "Cash retained", total: 750 }),
    ]));
  });

  it("combines equivalent household categories while retaining different types", () => {
    const result = summarizeActivity([
      row(-100, { categoryId: "charlie-housing", categoryName: "Housing", categoryType: "expense" }),
      row(-200, { categoryId: "jessica-housing", categoryName: "Housing", categoryType: "expense" }),
      row(500, { categoryId: "housing-income", categoryName: "Housing", categoryType: "income" }),
    ]);
    expect(result.categories).toHaveLength(2);
    expect(result.categories.find(c => c.type === "expense")?.amount).toBe(300);
    expect(activitySankey(result).nodes.filter(n => n.name === "Housing")).toHaveLength(2);
  });

  it("keeps category exclusions and zeroed secondary/fully reimbursed amounts excluded", () => {
    const result = summarizeActivity([
      row(200, { categoryType: "transfer" }), row(-200, { categoryType: "transfer" }),
      row(0), row(-30, { categoryId: "food", categoryType: "expense" }),
      row(20, { categoryId: "food", categoryType: "expense" }),
    ]);
    expect(result.income).toBe(0);
    expect(result.expenses).toBe(10);
  });

  it.each([
    [250, "Cash retained"], [-125, "Cash required"],
  ])("renders one-sided uncategorized activity %s", (amount, balancingName) => {
    const chart = activitySankey(summarizeActivity([row(amount)]));
    expect(chart.links).toHaveLength(1);
    expect(chart.links[0].value).toBe(Math.abs(amount));
    expect(chart.nodes.some((node) => node.name === balancingName)).toBe(true);
  });

  it("preserves all money when aggregating small categories", () => {
    const rows = Array.from({ length: 20 }, (_, index) => row(-10, {
      categoryId: `expense-${index}`, categoryName: `Expense ${index}`, categoryType: "expense",
    }));
    const result = summarizeActivity([row(300), ...rows]);
    const chart = activitySankey(result);
    expect(chart.nodes.find((node) => node.name === "Other expenses")?.total).toBe(120);
    expect(chart.links.reduce((sum, link) => sum + link.value, 0)).toBe(300);
  });

  it("nets categorized refunds and income reversals across every summary", () => {
    const expense = { categoryId: "food", categoryName: "Food", categoryType: "expense" };
    const income = { categoryId: "salary", categoryName: "Salary", categoryType: "income" };
    const result = summarizeActivity([
      row(-100, expense), row(30, expense), row(1000, income), row(-200, income),
    ]);
    expect(result.expenses).toBe(70);
    expect(result.income).toBe(800);
    expect(result.dailyData).toEqual([{ date: "2026-10-14", income: 800, expenses: 70 }]);
    expect(activitySankey(result).nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Food", total: 70 }),
      expect.objectContaining({ name: "Salary", total: 800 }),
      expect.objectContaining({ name: "Cash retained", total: 730 }),
    ]));
  });

  it("shows net refunds from earlier periods as cash inflow without negative Sankey links", () => {
    const result = summarizeActivity([
      row(80, { categoryId: "food", categoryName: "Food", categoryType: "expense" }),
      row(-30, { categoryId: "salary", categoryName: "Salary", categoryType: "income" }),
    ]);
    expect(result.expenses).toBe(-80);
    expect(result.income).toBe(-30);
    const chart = activitySankey(result);
    expect(chart.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Refunds: Food", total: 80, categoryType: "income" }),
      expect.objectContaining({ name: "Income reversals: Salary", total: 30, categoryType: "expense" }),
      expect.objectContaining({ name: "Cash retained", total: 50 }),
    ]));
    expect(chart.links.every((link) => link.value > 0)).toBe(true);
  });

  it("excludes missing foreign conversions while retaining available amounts", () => {
    const result = summarizeActivity([row(-25), row(-15, { amount: null })]);
    expect(result.expenses).toBe(25);
    expect(result.missingConversions).toBe(1);
  });

  it("returns a true empty state when no eligible activity remains", () => {
    expect(activitySankey(summarizeActivity([row(0), row(Number.NaN)])))
      .toEqual({ nodes: [], links: [] });
  });
});

describe("cash flow separates consumption, allocations and ownership transfers", () => {
  it("does not treat a partner's contribution as earned income or mortgage principal as consumption", () => {
    const result = summarizeActivity([
      row(6000, { categoryType: "income" }),
      row(-2000, { categoryType: "expense" }),
      row(0, { categoryType: "transfer", transferGroupId: "partner", transferAmount: 35000 }),
      row(-35000, { categoryType: "expense", cashFlowKind: "loan_principal" }),
    ]);
    expect(result).toMatchObject({ income: 6000, expenses: 2000, loanPrincipal: 35000, transfersIn: 35000 });
    const chart = activitySankey(result);
    expect(chart.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Loan principal", total: 35000 }),
      expect.objectContaining({ name: "Transfers in", total: 35000 }),
      expect.objectContaining({ name: "Cash retained", total: 4000 }),
    ]));
    expect(chart.nodes.some(n => n.name === "Cash required")).toBe(false);
  });

  it("handles arbitrary contribution amounts and ownership rates, independently of later payments", () => {
    const result = summarizeActivity([
      row(0, { categoryType: "transfer", transferGroupId: "topup", transferAmount: -1200 }),
      row(0, { categoryType: "transfer", transferGroupId: "topup", transferAmount: 300 }),
      row(-150, { categoryType: "expense", cashFlowKind: "investment" }),
    ]);
    expect(result).toMatchObject({ income: 0, expenses: 0, investments: 150, transfersOut: 900, transfersIn: 0 });
  });

  it("retains interest as spending when only part of a repayment is principal", () => {
    const result = summarizeActivity([row(-1000, { categoryType: "expense", cashFlowParts: [{ kind: "capital", detail: "loan_principal", amount: 600 }, { kind: "consumption", amount: 400 }] })]);
    expect(result).toMatchObject({ expenses: 400, loanPrincipal: 600 });
    expect(result.dailyData[0].expenses).toBe(400);
  });

  it("shows investment withdrawals separately from income and offsets allocations", () => {
    const result = summarizeActivity([
      row(-1000, { cashFlowKind: "investment" }),
      row(1500, { cashFlowKind: "investment" }),
    ]);
    expect(result).toMatchObject({ investments: -500, income: 0, expenses: 0 });
    expect(activitySankey(result).nodes).toContainEqual(expect.objectContaining({ name: "Returned: Investments", total: 500 }));
  });

  it("cancels equal-share transfer legs and does not count ordinary reimbursements as contributions", () => {
    const result = summarizeActivity([
      row(0, { categoryType: "transfer", transferGroupId: "same", transferAmount: -100 }),
      row(0, { categoryType: "transfer", transferGroupId: "same", transferAmount: 100 }),
      row(-80, { categoryType: "expense", transferGroupId: "refund", transferAmount: -100 }),
    ]);
    expect(result).toMatchObject({ expenses: 80, transfersIn: 0, transfersOut: 0 });
  });

  it("keeps explicit everyday overrides and unclassified housing in consumption", () => {
    const result = summarizeActivity([
      row(-1000, { categoryName: "Housing", categoryType: "expense" }),
      row(-200, { categoryName: "Investment Transfer", categoryType: "expense", cashFlowKind: "activity" }),
    ]);
    expect(result).toMatchObject({ expenses: 1200, investments: 0, loanPrincipal: 0 });
  });

  it("flags missing FX conversion on permitted transfer legs", () => {
    const result = summarizeActivity([
      row(0, { categoryType: "transfer", transferGroupId: "fx", transferAmount: 100 }),
      row(0, { categoryType: "transfer", transferGroupId: "fx", transferAmount: null }),
    ]);
    expect(result).toMatchObject({ missingConversions: 1, transfersIn: 0, transfersOut: 0 });
  });
});

it("uses the same capital rule for arbitrary complete portions without assuming a remainder", () => {
  const result = summarizeActivity([row(-1000, { cashFlowParts: [
    { kind: "consumption", amount: 100 }, { kind: "capital", detail: "investment", amount: 200 },
    { kind: "capital", detail: "loan_principal", amount: 300 }, { kind: "capital", detail: "other", amount: 400 },
  ] })]);
  expect(result).toMatchObject({ expenses: 100, investments: 200, loanPrincipal: 300, otherCapital: 400, income: 0 });
});
