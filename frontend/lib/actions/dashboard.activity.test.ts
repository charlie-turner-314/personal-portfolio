import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const results: unknown[][] = [];
  const queries: { joins: string[]; where?: unknown; select?: unknown }[] = [];
  const boundaries:unknown[]=[];
  return { results, queries, boundaries, db: { select: vi.fn((select: unknown) => {
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
vi.mock("@/lib/reporting/activity-query",()=>({fetchFinancialActivity:async(actor:string,boundary:unknown)=>{
  mocks.boundaries.push({actor,boundary});
  const {summarizeActivity}=await import("@/lib/dashboard/activity");
  return summarizeActivity((mocks.results.shift()??[]) as Parameters<typeof summarizeActivity>[0]);
}}));
vi.mock("@/lib/household/financial-auth", () => ({ getAuthenticatedSession: async () => ({ user: { id: "user-1" }, householdPersonId: "linked-person" }) }));
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
  beforeEach(() => { mocks.results.length = 0; mocks.queries.length = 0; mocks.boundaries.length=0; });
  it("passes the authenticated actor and exact selected reporting boundary to the shared calculation",async()=>{
    mocks.results.push(fixture);
    expect((await getSpendingHistory(from,to,["account-1"],"person-1"))[0].value).toBe(150);
    expect(mocks.boundaries).toEqual([{actor:"user-1",boundary:{startDate:from,endDate:to,accountIds:["account-1"],personId:"person-1"}}]);
  });
  it.each([undefined,"all"])("preserves the My/Household scope %s",async(personId)=>{
    mocks.results.push(fixture);
    await getSpendingHistory(from,to,undefined,personId);
    expect(mocks.boundaries).toEqual([{actor:"user-1",boundary:{startDate:from,endDate:to,accountIds:undefined,personId}}]);
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
      expect.objectContaining({ name: "Calculated net inflow", total: 850 }),
    ]));
  });
});
