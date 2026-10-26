// @vitest-environment node
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { categories, type Category } from "@/lib/db/schema";
import { categoryAccess, categoryDefinitionForActor } from "./category-access";

it("shares definitions without private guidance, links, timestamps or future fields", () => {
  const source = {
    id: "category", userId: "partner", name: "Housing", categoryType: "expense",
    cashFlowKind: "loan_principal", color: "#123456", icon: "home", isSystem: false,
    hideFromSelection: false, parentId: "private-parent", description: "private property",
    categorizationInstructions: "private instructions", createdAt: new Date(),
    futurePrivateField: "must not escape",
  } as Category;
  expect(categoryDefinitionForActor(source, "partner")).toBe(source);
  expect(categoryDefinitionForActor(source, "member")).toEqual({
    id: "category", userId: "", name: "Housing", categoryType: "expense",
    cashFlowKind: "loan_principal", color: "#123456", icon: "home", isSystem: false,
    hideFromSelection: false, parentId: null, description: null,
    categorizationInstructions: null, createdAt: null,
  });
  expect(source.description).toBe("private property");
});

const container = process.env.OWNERSHIP_TEST_POSTGRES_CONTAINER;
describe.skipIf(!container)("category vocabulary boundaries on PostgreSQL", () => {
  function query(actor: string) {
    const query = new PgDialect().sqlToQuery(sql`SELECT ${categories.id} FROM ${categories}
      WHERE ${categoryAccess(actor)} ORDER BY ${categories.id}`);
    return query.sql.replace(/\$(\d+)/g, (_, index) => `'${String(query.params[Number(index) - 1]).replaceAll("'", "''")}'`);
  }
  it("shares definitions symmetrically and retains classifications after leaving", () => {
    const fixture = `BEGIN;
      CREATE TEMP TABLE household_memberships(member_user_id text, owner_user_id text);
      CREATE TEMP TABLE household_account_shares(account_id text, member_user_id text, granted_by_user_id text);
      CREATE TEMP TABLE accounts(id text,user_id text,is_active boolean,consolidated_into_account_id text);
      CREATE TEMP TABLE categories(id text,user_id text);
      CREATE TEMP TABLE transactions(id text,account_id text,category_id text,category_system_id text);
      CREATE TEMP TABLE category_vocabulary_entries(owner_user_id text,category_id text);
      INSERT INTO household_memberships VALUES ('member','admin');
      INSERT INTO accounts VALUES ('joint','admin',true,NULL),('private','admin',true,NULL),('personal','member',true,NULL);
      INSERT INTO household_account_shares VALUES ('joint','member','admin');
      INSERT INTO categories VALUES ('admin-used','admin'),('admin-unused','admin'),('member-definition','member'),('outsider-definition','outsider');
      INSERT INTO transactions VALUES ('shared','joint','admin-used',NULL),('retained','personal','admin-used',NULL);
      ${query('member')};
      SELECT 'admin'; ${query('admin')};
      SELECT 'outsider'; ${query('outsider')};
      INSERT INTO category_vocabulary_entries VALUES ('member','admin-used');
      DELETE FROM household_memberships;
      SELECT 'after-leaving'; ${query('member')};
      ROLLBACK;`;
    const result = execFileSync("docker", ["exec", "-i", container!, "psql", "-U", "postgres", "-d", "postgres", "-qAt", "-v", "ON_ERROR_STOP=1"], { input: fixture, encoding: "utf8" });
    expect(result.trim().split("\n")).toEqual([
      'admin-unused','admin-used','member-definition',
      'admin','admin-unused','admin-used','member-definition',
      'outsider','outsider-definition',
      'after-leaving','admin-used','member-definition',
    ]);
  });
});
