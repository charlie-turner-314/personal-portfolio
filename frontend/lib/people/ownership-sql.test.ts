// @vitest-environment node
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { ownershipShareSql, type OwnershipScope } from "./ownership-sql";

const container = process.env.OWNERSHIP_TEST_POSTGRES_CONTAINER;
const fixture = `
CREATE TEMP TABLE household_memberships(person_id text, member_user_id text);
INSERT INTO household_memberships VALUES ('partner','member-login');
CREATE TEMP TABLE accounts (id text, user_id text);
CREATE TEMP TABLE people (id text, user_id text, kind text, linked_user_id text);
CREATE TEMP TABLE account_owners (account_id text, person_id text, share numeric);
CREATE TEMP TABLE account_ownership_allocations (account_id text, person_id text, effective_from date, share numeric);
INSERT INTO accounts VALUES ('dated','household'),('legacy','household'),('default','household'),('future','household'),('personal','member-login'),('new-account','new-login');
INSERT INTO people(id,user_id,kind) VALUES ('self','household','self'),('partner','household','member'),('outsider','another','self'),('member-self','member-login','self');
INSERT INTO account_owners VALUES ('legacy','self',NULL),('legacy','partner',NULL),('future','self',1);
INSERT INTO account_ownership_allocations VALUES
('dated','self','2026-01-01',0.25),('dated','partner','2026-01-01',0.75),
('dated','partner','2026-07-01',1),('future','partner','2030-01-01',1);
`;
function share(person: OwnershipScope | undefined, account: string, date: string): number {
  const query = new PgDialect().sqlToQuery(sql`SELECT ${ownershipShareSql(person, sql`${account}`, sql`${date}`)}`);
  const literal = query.sql.replace(/\$(\d+)/g, (_, index) => `'${String(query.params[Number(index) - 1]).replaceAll("'", "''")}'`);
  return Number(execFileSync("docker", ["exec", "-i", container!, "psql", "-U", "postgres", "-d", "postgres", "-qAt", "-v", "ON_ERROR_STOP=1"], { input: fixture + literal + ";", encoding: "utf8" }).trim());
}
describe.skipIf(!container)("dated ownership SQL against isolated PostgreSQL", () => {
  it("resolves complete sets and drops removed owners exactly on their effective date", () => {
    expect(share("self", "dated", "2026-06-30")).toBe(0.25);
    expect(share("self", "dated", "2026-07-01")).toBe(0);
    expect(share("partner", "dated", "2026-07-01")).toBe(1);
    expect(share("self", "dated", "2025-12-31")).toBe(0);
  });
  it("does not resurrect timeless ownership before a future allocation", () => {
    expect(share("self", "future", "2026-01-01")).toBe(0);
    expect(share("partner", "future", "2030-01-01")).toBe(1);
  });
  it("retains legacy equal splits and the self-only default without allocation history", () => {
    expect(share("self", "legacy", "2026-01-01")).toBe(0.5);
    expect(share("partner", "legacy", "2026-01-01")).toBe(0.5);
    expect(share("self", "default", "2026-01-01")).toBe(1);
    expect(share("partner", "default", "2026-01-01")).toBe(0);
    expect(share("outsider", "default", "2026-01-01")).toBe(0);
  });
  it("combines a member's own self identity and linked household identity", () => {
    const viewer = { userId: "member-login", householdPersonId: "partner" };
    expect(share(viewer, "dated", "2026-06-30")).toBe(0.75);
    expect(share(viewer, "dated", "2026-07-01")).toBe(1);
    expect(share(viewer, "legacy", "2026-01-01")).toBe(0.5);
    expect(share(viewer, "personal", "2026-01-01")).toBe(1);
    expect(share("partner", "personal", "2026-01-01")).toBe(1);
    expect(share(viewer, "default", "2026-01-01")).toBe(0);
  });
  it("retains a new login's unallocated own accounts before a self record exists", () => {
    expect(share({ userId: "new-login" }, "new-account", "2026-01-01")).toBe(1);
    expect(share({ userId: "new-login" }, "default", "2026-01-01")).toBe(0);
  });
  it("keeps household scope at full value", () => {
    expect(share(undefined, "dated", "2026-07-01")).toBe(1);
  });
});
