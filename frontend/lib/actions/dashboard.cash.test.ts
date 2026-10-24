import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  session: vi.fn(),
}));
vi.mock("@/lib/db", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  return { db: drizzle(mocks.execute) };
});
vi.mock("@/lib/household/financial-auth", () => ({ getAuthenticatedSession: mocks.session }));
vi.mock("@/lib/data/cached", () => ({ getCachedUserAccounts: vi.fn() }));
vi.mock("@/lib/api/investments", () => ({ getPortfolio: vi.fn() }));
vi.mock("@/lib/actions/planned-expenses", () => ({ getUpcomingPlannedExpenses: vi.fn() }));

import { getTotalBalance, getBalanceHistory } from "./dashboard";
import { LIABILITY_ACCOUNT_TYPE_VALUES } from "@/lib/constants/account-types";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ user: { id: "current-user" } });
  mocks.execute.mockImplementation(async (query: string) => ({
    rows: query.includes('"functional_currency"') ? [["AUD"]] : [["3250"]],
  }));
});

describe("dashboard cash queries", () => {
  it("restricts cash to active user-owned bank/cash accounts, preserving negative balances", async () => {
    expect(await getTotalBalance()).toEqual({ total: 3250, currency: "AUD" });
    const [query, params] = mocks.execute.mock.calls.find(([query]) => query.includes("SUM"))!;
    expect(params).toEqual(expect.arrayContaining(["current-user", true, "checking", "savings", "cash"]));
    for (const type of [...LIABILITY_ACCOUNT_TYPE_VALUES, "investment", "superannuation"]) {
      expect(params).not.toContain(type);
    }
    expect(query).not.toMatch(/ABS\(|GREATEST\(/i);
    expect(query).toContain('"accounts"."is_active"');
    expect(query).toContain("ORDER BY ab.date DESC LIMIT 1");
    expect(query).toContain('"accounts"."functional_balance"');
    expect(query).toContain("ab.date::date <= CURRENT_DATE");
  });

  it("honours account selection and current ownership, even for stale balance snapshots", async () => {
    await getTotalBalance(["selected-account"], "person-half");
    const [query, params] = mocks.execute.mock.calls.find(([query]) => query.includes("SUM"))!;
    expect(params).toContain("selected-account");
    expect(params).toContain("person-half");
    expect(query).toMatch(/effective_from <= \(CURRENT_DATE\)::date/);
  });

  it("carries cash snapshots forward separately and never reads net-worth snapshots", async () => {
    mocks.execute.mockResolvedValue({ rows: [["2026-10-15", "-250"]] });
    expect(await getBalanceHistory(new Date("2026-10-01T00:00:00Z"), new Date("2026-10-15T00:00:00Z")))
      .toEqual([{ date: "2026-10-15", value: -250 }]);
    const [query, params] = mocks.execute.mock.calls[0];
    expect(query).toContain("generate_series");
    expect(query).toContain("LATERAL");
    expect(query).toContain("ab.date::date <= cash_days.day::date");
    expect(query).not.toContain("historical_snapshots");
    expect(params).toEqual(expect.arrayContaining(["checking", "savings", "cash"]));
    expect(params).not.toContainEqual(expect.any(Date));
  });

  it("does not query balances for an unauthenticated caller", async () => {
    mocks.session.mockResolvedValue(null);
    expect(await getTotalBalance()).toEqual({ total: 0, currency: "EUR" });
    expect(await getBalanceHistory(new Date(), new Date())).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

// Opt-in PostgreSQL execution against an isolated disposable container. All
// fixtures are TEMP tables and disappear with this psql session.
describe.runIf(process.env.CASH_TEST_POSTGRES_CONTAINER)("cash SQL on PostgreSQL", () => {
  it("excludes liabilities/investments, preserves overdrafts, and carries sparse snapshots forward", async () => {
    const { execFileSync } = await import("node:child_process");
    const quote = (value: unknown) => typeof value === "boolean" ? String(value)
      : value === null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
    const bind = (query: string, params: unknown[]) => query.replace(/\$(\d+)/g, (_, n) => quote(params[Number(n) - 1]));
    await getTotalBalance();
    const totalCall = mocks.execute.mock.calls.find(([query]) => query.includes("SUM"))!;
    mocks.execute.mockClear();
    await getTotalBalance(undefined, "person-half");
    const personCall = mocks.execute.mock.calls.find(([query]) => query.includes("SUM"))!;
    mocks.execute.mockClear();
    const end = new Date();
    const start = new Date(end.getTime() - 2 * 86_400_000);
    await getBalanceHistory(start, end);
    const historyCall = mocks.execute.mock.calls[0];
    const fixture = `
      BEGIN;
      CREATE TEMP TABLE accounts(id text, user_id text, is_active boolean, account_type text, functional_balance numeric);
      CREATE TEMP TABLE account_balances(account_id text, date timestamp, balance_in_functional_currency numeric);
      CREATE TEMP TABLE people(id text, user_id text, kind text);
      CREATE TEMP TABLE account_owners(account_id text, person_id text, share numeric);
      CREATE TEMP TABLE account_ownership_allocations(account_id text, person_id text, effective_from date, share numeric);
      INSERT INTO accounts VALUES
        ('checking', 'current-user', true, 'checking', 99999),
        ('savings', 'current-user', true, 'savings', 2000),
        ('manual-cash', 'current-user', true, 'cash', 500),
        ('overdraft', 'current-user', true, 'checking', -250),
        ('mortgage', 'current-user', true, 'mortgage', 9000),
        ('card', 'current-user', true, 'credit_card', -400),
        ('investment', 'current-user', true, 'investment', 9999),
        ('super', 'current-user', true, 'superannuation', 8888),
        ('other', 'current-user', true, 'other', 7777),
        ('inactive', 'current-user', false, 'cash', 12345),
        ('other-user', 'other-user', true, 'cash', 12345);
      INSERT INTO account_balances VALUES
        ('checking', CURRENT_DATE - 5, 1000),
        ('checking', CURRENT_DATE + 1, 123456),
        ('savings', CURRENT_DATE - 1, 2000),
        ('overdraft', CURRENT_DATE - 5, -250);
      INSERT INTO account_ownership_allocations
        SELECT id, 'person-half', CURRENT_DATE - 30, 0.5 FROM accounts;
      ${bind(totalCall[0], totalCall[1])};
      ${bind(personCall[0], personCall[1])};
      ${bind(historyCall[0], historyCall[1])};
      ROLLBACK;
    `;
    const output = execFileSync("docker", ["exec", "-i", process.env.CASH_TEST_POSTGRES_CONTAINER!, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-v", "ON_ERROR_STOP=1"], { input: fixture, encoding: "utf8" }).trim().split("\n");
    expect(Number(output[0])).toBe(3250);
    expect(Number(output[1])).toBe(1625);
    expect(output.slice(2).map(line => Number(line.split("|")[1]))).toEqual([750, 2750, 3250]);
  });
});
