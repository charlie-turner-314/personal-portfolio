import { beforeEach, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), execute: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { transaction: mocks.transaction } }));
import { getVisibleNetWorthTotals } from "./net-worth";
const dialect = new PgDialect();
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async callback => callback({ execute: mocks.execute }));
});
it("scopes compilation settings to the aggregate transaction and keeps actor-specific totals", async () => {
  mocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([
    { user_id: "member", name: "Member", currency: "AUD", total: "550" },
    { user_id: "other", name: "Other", currency: "AUD", total: null },
  ]);
  expect(await getVisibleNetWorthTotals("member")).toEqual([
    { userId: "member", name: "Member", currency: "AUD", total: "550", isOwn: true },
    { userId: "other", name: "Other", currency: "AUD", total: null, isOwn: false },
  ]);
  expect(mocks.transaction).toHaveBeenCalledTimes(1);
  expect(dialect.sqlToQuery(mocks.execute.mock.calls[0][0]).sql).toBe("SET LOCAL jit = off");
  expect(dialect.sqlToQuery(mocks.execute.mock.calls[1][0]).params).toContain("member");
});
it("does not reuse a previous actor's projection or suppress query errors", async () => {
  mocks.execute.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("database unavailable"));
  await expect(getVisibleNetWorthTotals("first")).rejects.toThrow("database unavailable");
  mocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  expect(await getVisibleNetWorthTotals("second")).toEqual([]);
  expect(mocks.transaction).toHaveBeenCalledTimes(2);
  expect(dialect.sqlToQuery(mocks.execute.mock.calls[3][0]).params).toContain("second");
});
