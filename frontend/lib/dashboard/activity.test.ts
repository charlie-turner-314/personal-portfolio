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
      expect.objectContaining({ name: "Savings", total: 750 }),
    ]));
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
    [250, "Savings"], [-125, "Funding Gap"],
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
      expect.objectContaining({ name: "Savings", total: 730 }),
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
      expect.objectContaining({ name: "Savings", total: 50 }),
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
