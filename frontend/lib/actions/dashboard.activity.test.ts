import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const mocks = vi.hoisted(() => {
  const results: unknown[][] = [];
  const queries: { joins: string[]; where?: unknown; select?: unknown }[] = [];
  return { results, queries, db: { select: vi.fn((select: unknown) => {
    const query = { joins: [] as string[], where: undefined as unknown, select };
    queries.push(query);
    const result = results.shift() ?? [];
    const builder = {
      from: () => builder,
      leftJoin: () => { query.joins.push("left"); return builder; },
      innerJoin: () => { query.joins.push("inner"); return builder; },
      where: (where: unknown) => { query.where = where; return builder; },
      limit: () => Promise.resolve(result),
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve),
    };
    return builder;
  }) } };
});
vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/auth-helpers", () => ({ getAuthenticatedSession: async () => ({ user: { id: "user-1" } }) }));
vi.mock("@/lib/data/cached", () => ({ getCachedUserAccounts: vi.fn() }));
vi.mock("@/lib/api/investments", () => ({ getPortfolio: vi.fn() }));
vi.mock("@/lib/actions/planned-expenses", () => ({ getUpcomingPlannedExpenses: vi.fn() }));
vi.mock("@/lib/actions/historical-snapshots", () => ({ getHistoricalSnapshotHistory: vi.fn() }));
import { getPeriodIncome, getPeriodSpending, getIncomeHistory, getSpendingHistory, getIncomeExpenseData, getSpendingByCategory, getSankeyData } from "./dashboard";

const from = new Date("2026-10-01T00:00:00Z");
const to = new Date("2026-10-30T23:59:59Z");
const fixture = [1000, -100, -50].map((amount) => ({
  date: "2026-10-14", amount: String(amount), categoryId: null,
  categoryName: null, categoryType: null, icon: null, color: null,
}));

describe("dashboard activity queries", () => {
  beforeEach(() => { mocks.results.length = 0; mocks.queries.length = 0; });
  it("keeps uncategorized rows eligible while applying visibility, transfer and user filters", async () => {
    mocks.results.push(fixture);
    expect((await getSpendingHistory(from, to, ["account-1"], "person-1"))[0].value).toBe(150);
    const query = mocks.queries[0];
    expect(query.joins).toEqual(["left", "left"]);
    const dialect = new PgDialect();
    const where = dialect.sqlToQuery(query.where as SQL);
    expect(where.sql).toContain('"transactions"."include_in_analytics"');
    expect(where.sql).toContain('"transactions"."internal_transfer_id" is null');
    expect(where.sql).toContain('"transactions"."booked_at" >=');
    expect(where.sql).toContain('"transactions"."booked_at" <=');
    expect(where.params).toEqual(expect.arrayContaining(["user-1", true, "account-1"]));
    expect(where.sql).not.toContain('"categories"');
    const amount = dialect.sqlToQuery((query.select as { amount: SQL }).amount);
    expect(amount.sql).toContain("t2.user_id =");
    expect(amount.sql).toContain("t2.include_in_analytics = true");
    expect(amount.sql).toContain("aoa.share");
    expect(amount.sql).toContain('COALESCE("transactions"."functional_amount", CASE WHEN "transactions"."currency"');
    expect(amount.sql).toContain('THEN "transactions"."amount" END)');
    expect(amount.sql).toContain("t2.functional_amount");
    expect(amount.sql).toContain("IS NULL) > 0 THEN NULL");
    expect(amount.params).toContain("person-1");
  });

  it("returns consistent totals across each dashboard widget", async () => {
    // The currency lookup begins before the async activity lookup resumes.
    mocks.results.push([{ functionalCurrency: "AUD" }], fixture);
    expect(await getPeriodIncome(from, to)).toEqual({ total: 1000, currency: "AUD" });
    mocks.results.push([{ functionalCurrency: "AUD" }], fixture);
    expect(await getPeriodSpending(from, to)).toEqual({ total: 150, currency: "AUD" });
    mocks.results.push(fixture);
    expect(await getIncomeHistory(from, to)).toEqual([{ date: "2026-10-14", value: 1000 }]);
    mocks.results.push(fixture);
    const chart = await getIncomeExpenseData(from, to);
    expect(chart.reduce((sum, bucket) => sum + bucket.income, 0)).toBe(1000);
    expect(chart.reduce((sum, bucket) => sum + bucket.expenses, 0)).toBe(150);
    mocks.results.push(fixture);
    expect((await getSpendingByCategory(from, to)).total).toBe(150);
    mocks.results.push(fixture);
    expect((await getSankeyData(from, to)).nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Uncategorized expenses", total: 150 }),
      expect.objectContaining({ name: "Savings", total: 850 }),
    ]));
  });
});
