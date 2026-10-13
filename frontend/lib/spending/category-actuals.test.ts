import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core/dialect";

vi.mock("@/lib/db", () => ({ db: {} }));

import { buildLinkedExpenseAmountSql } from "./category-actuals";

describe("buildLinkedExpenseAmountSql", () => {
  it("encodes raw alias date bounds with the transaction timestamp encoder", () => {
    const query = new PgDialect().sqlToQuery(
      buildLinkedExpenseAmountSql({
        userId: "user-1",
        startDate: new Date("2026-04-01T00:00:00.000Z"),
        endDate: new Date("2026-04-30T23:59:59.999Z"),
        accountIds: [],
      })
    );

    expect(query.params).toContain("2026-04-01T00:00:00.000Z");
    expect(query.params).toContain("2026-04-30T23:59:59.999Z");
    expect(query.params).not.toContainEqual(expect.any(Date));
  });

  it("applies the effective allocation for a selected household person", () => {
    const query = new PgDialect().sqlToQuery(
      buildLinkedExpenseAmountSql({
        userId: "user-1",
        startDate: new Date("2026-04-01T00:00:00.000Z"),
        endDate: new Date("2026-04-30T23:59:59.999Z"),
        accountIds: [],
        personId: "person-half",
      })
    );

    expect(query.sql).toContain("account_ownership_allocations");
    expect(query.sql).toContain("effective_from <= t2.booked_at::date");
    expect(query.params).toContain("person-half");
  });
});
