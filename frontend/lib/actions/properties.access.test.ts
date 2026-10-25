import { expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
const mocks = vi.hoisted(() => ({ findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/db", () => ({ db: { query: { properties: mocks } } }));
vi.mock("@/lib/household/financial-auth", () => ({ requireAuth: async () => "member-login" }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { getProperties, getProperty } from "./properties";
it("uses explicit property grants for both list and detail rather than login ownership alone", async () => {
  await getProperties();
  await getProperty("property-id");
  for (const query of [mocks.findMany.mock.calls[0][0], mocks.findFirst.mock.calls[0][0]]) {
    const where = new PgDialect().sqlToQuery(query.where as SQL);
    expect(where.sql).toContain("household_property_shares");
    expect(where.sql).toContain("household_memberships");
    expect(where.params).toContain("member-login");
  }
});
