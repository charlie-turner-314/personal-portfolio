// @vitest-environment node
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { groupReportingCategories } from "./reporting";
import { reportingCategoryFilter } from "./reporting-sql";
import { accountAccess } from "@/lib/household/account-access";
it("groups display names and types, retaining source IDs and stable representatives", () => {
  const categories = [
    { id: "b", name: "Housing", categoryType: "expense" },
    { id: "a", name: " housing ", categoryType: "expense" },
    { id: "c", name: "Housing", categoryType: "income" },
  ];
  const groups = groupReportingCategories(categories);
  expect(groups).toHaveLength(2);
  expect(groups.find(g => g.categoryType === "expense")).toMatchObject({ id: "a", categoryIds: ["a", "b"] });
  expect(groupReportingCategories([...categories].reverse())).toEqual(groups);
  expect(categories).toHaveLength(3);
});
describe.skipIf(!process.env.OWNERSHIP_TEST_POSTGRES_CONTAINER)("household category filter on PostgreSQL", () => {
  it("includes both visible Housing IDs, preserves category type and enforces permission", () => {
    const query = new PgDialect().sqlToQuery(sql`SELECT id FROM transactions
      WHERE ${accountAccess(sql`transactions.account_id`, "viewer")}
        AND ${reportingCategoryFilter(sql`COALESCE(category_id, category_system_id)`, ["housing-a"])} ORDER BY id`);
    const literal = query.sql.replace(/\$(\d+)/g, (_, index) => `'${String(query.params[Number(index) - 1]).replaceAll("'", "''")}'`);
    const fixture = `BEGIN;
      CREATE TEMP TABLE accounts(consolidated_into_account_id text, id text, user_id text, is_active boolean);
      CREATE TEMP TABLE household_memberships(member_user_id text, owner_user_id text);
      CREATE TEMP TABLE household_account_shares(account_id text, member_user_id text, granted_by_user_id text);
      CREATE TEMP TABLE categories(id text, name text, category_type text);
      CREATE TEMP TABLE transactions(id text, account_id text, category_id text, category_system_id text);
      INSERT INTO accounts(id,user_id,is_active) VALUES ('own','viewer',true),('shared','owner',true),('private','owner',true);
      INSERT INTO household_memberships VALUES ('viewer','owner');
      INSERT INTO household_account_shares VALUES ('shared','viewer','owner');
      INSERT INTO categories VALUES ('housing-a','Housing','expense'),('housing-b',' housing ','expense'),('housing-income','Housing','income');
      INSERT INTO transactions VALUES ('one','own','housing-a',NULL),('two','shared',NULL,'housing-b'),('private','private','housing-b',NULL),('income','shared','housing-income',NULL),('overridden','shared','housing-income','housing-b');
      ${literal}; ROLLBACK;`;
    const result = execFileSync("docker", ["exec", "-i", process.env.OWNERSHIP_TEST_POSTGRES_CONTAINER!, "psql", "-U", "postgres", "-d", "postgres", "-qAt", "-v", "ON_ERROR_STOP=1"], { input: fixture, encoding: "utf8" });
    expect(result.trim().split("\n")).toEqual(["one", "two"]);
  });
});
