import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
const mocks = vi.hoisted(() => ({ rows: {} as Record<string, unknown[]>, selections: [] as Record<string, unknown>[], portfolio: vi.fn(), owners: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({ getAuthenticatedSession: async () => ({ user: { id: "user" } }) }));
vi.mock("@/lib/api/investments", () => ({ getPortfolio: mocks.portfolio }));
vi.mock("@/lib/people/queries", () => ({ getOwnersForEntities: mocks.owners }));
vi.mock("@/lib/data/cached", () => ({ getCachedUserAccounts: vi.fn() }));
vi.mock("@/lib/actions/planned-expenses", () => ({ getUpcomingPlannedExpenses: vi.fn() }));
vi.mock("@/lib/actions/historical-snapshots", () => ({ getHistoricalSnapshotHistory: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { select: (selection: Record<string, unknown>) => {
  mocks.selections.push(selection);
  return { from: (table: Parameters<typeof getTableName>[0]) => {
    const result = Promise.resolve(mocks.rows[getTableName(table)] || []);
    const chain = { leftJoin: () => chain, where: () => chain, limit: () => chain, then: result.then.bind(result) };
    return chain;
  } };
} } }));
import { getAssetsOverview } from "./dashboard";
const account = (id: string, accountType: string, balance: number, share = 1) => ({ id, name: id, accountType, institution: "Bank", currency: "AUD", functionalBalance: balance, ownershipShare: share, superAccountId: null });
describe("net worth account and ownership orchestration", () => {
  beforeEach(() => {
    mocks.selections.length = 0;
    mocks.rows = { accounts: [account("cash", "savings", 25000), account("mortgage", "mortgage", 520000)], properties: [{ id: "home", name: "Home", currentValue: "750000", currency: "AUD" }], vehicles: [], users: [{ functionalCurrency: "AUD" }] };
    mocks.portfolio.mockResolvedValue({ accounts: [], currency: "AUD" });
    mocks.owners.mockResolvedValue(new Map());
  });
  it("reports gross property and debt once instead of reporting only equity", async () => {
    const result = await getAssetsOverview();
    expect(result).toMatchObject({ grossAssets: 775000, totalLiabilities: 520000, netWorth: 255000, scope: "Whole household" });
    expect(result.categories.find((c) => c.key === "property")?.value).toBe(750000);
    expect(result.liabilities).toHaveLength(1);
  });
  it("independently attributes property, mortgage, cash and vehicle to the selected person", async () => {
    mocks.rows.accounts = [account("cash", "savings", 25000, 0.5), account("mortgage", "mortgage", 520000, 0.25)];
    mocks.rows.vehicles = [{ id: "car", name: "Car", currentValue: 10000, currency: "AUD" }];
    mocks.owners.mockImplementation(async (entity: string) => new Map([[entity === "property" ? "home" : "car", [{ personId: "self", share: 0.5 }, { personId: "partner", share: 0.5 }]]]));
    const result = await getAssetsOverview(undefined, "self");
    expect(result).toMatchObject({ grossAssets: 392500, totalLiabilities: 130000, netWorth: 262500, scope: "Selected person’s share" });
    const selection = mocks.selections.find((s) => s.ownershipShare);
    const query = new PgDialect().sqlToQuery(selection!.ownershipShare as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(query.params).toContain("self"); expect(query.sql).toContain("CURRENT_DATE");
    expect(mocks.owners).toHaveBeenCalledWith("property", ["home"]);
  });
  it("keeps a mortgage owner's liability even if they own none of the property", async () => {
    mocks.rows.accounts = [account("mortgage", "mortgage", 520000, 0.25)];
    expect(await getAssetsOverview(undefined, "self")).toMatchObject({ grossAssets: 0, totalLiabilities: 130000, netWorth: -130000 });
  });
  it("replaces investment balances with holdings once and applies the account share", async () => {
    mocks.rows.accounts = [account("broker", "investment_brokerage", 100000, 0.4)]; mocks.rows.properties = [];
    mocks.portfolio.mockResolvedValue({ accounts: [{ id: "broker", name: "Broker", value: "120000" }], currency: "AUD" });
    expect(await getAssetsOverview(undefined, "self")).toMatchObject({ grossAssets: 48000, netWorth: 48000 });
  });
  it("limits account-filtered results to selected accounts", async () => {
    expect(await getAssetsOverview(["cash"])).toMatchObject({ grossAssets: 25000, totalLiabilities: 0, netWorth: 25000, accountFiltered: true });
  });
});
