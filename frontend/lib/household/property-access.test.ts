// @vitest-environment node
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { accountAccess, propertyAccess } from "./account-access";
import { propertyOwnershipShareSql } from "@/lib/people/ownership-sql";
const container = process.env.OWNERSHIP_TEST_POSTGRES_CONTAINER;
const literal = (statement: SQL) => {
  const query = new PgDialect().sqlToQuery(statement);
  return query.sql.replace(/\$(\d+)/g, (_, n) => query.params[Number(n) - 1] === null ? "NULL" : `'${String(query.params[Number(n) - 1]).replaceAll("'", "''")}'`) + ";";
};
describe.skipIf(!container)("property consent and ownership on PostgreSQL", () => {
  it("separates ownership, property grants and mortgage grants; revocation is live", () => {
    const visible = literal(sql`SELECT 'visible:' || COALESCE(string_agg(p.id, ',' ORDER BY p.id), '') FROM properties p WHERE ${propertyAccess(sql`p.id`, "member")}`);
    const links = literal(sql`SELECT 'links:' || count(*) FROM property_liability_links link
      WHERE ${propertyAccess(sql`link.property_id`, "member")} AND ${accountAccess(sql`link.account_id`, "member")}`);
    const shares = literal(sql`SELECT 'shares:' || string_agg(p.id || '=' || (${propertyOwnershipShareSql({ userId: "member", householdPersonId: "linked" }, sql`p.id`)})::numeric(3,2), ',' ORDER BY p.id)
      FROM properties p WHERE ${propertyAccess(sql`p.id`, "member")}`);
    const fixture = `BEGIN;
      CREATE TEMP TABLE properties(id text, user_id text, is_active boolean);
      CREATE TEMP TABLE household_property_shares(property_id text, member_user_id text, granted_by_user_id text);
      CREATE TEMP TABLE accounts(consolidated_into_account_id text, id text, user_id text, is_active boolean);
      CREATE TEMP TABLE household_account_shares(account_id text, member_user_id text, granted_by_user_id text);
      CREATE TEMP TABLE household_memberships(member_user_id text, owner_user_id text, person_id text);
      CREATE TEMP TABLE people(id text, user_id text, kind text, linked_user_id text);
      CREATE TEMP TABLE property_owners(property_id text, person_id text, share numeric);
      CREATE TEMP TABLE property_ownership_allocations(property_id text, person_id text, share numeric, effective_from date);
      CREATE TEMP TABLE property_liability_links(property_id text, account_id text);
      INSERT INTO household_memberships VALUES ('member','owner','linked');
      INSERT INTO people(id,user_id,kind) VALUES ('linked','owner','member'),('owner-self','owner','self'),('self','member','self');
      INSERT INTO properties VALUES ('home','owner',true),('private','owner',true),('own','member',true),('foreign','outsider',true);
      INSERT INTO property_owners VALUES ('home','linked',NULL),('home','owner-self',NULL),('private','linked',1);
      INSERT INTO accounts(id,user_id,is_active) VALUES ('mortgage','owner',true);
      INSERT INTO property_liability_links VALUES ('home','mortgage');
      ${visible}
      INSERT INTO household_property_shares VALUES ('home','member','owner'),('foreign','member','outsider');
      ${visible} ${links} ${shares}
      INSERT INTO household_account_shares VALUES ('mortgage','member','owner');
      ${links}
      DELETE FROM household_memberships WHERE member_user_id='member';
      ${visible} ${links}
      ROLLBACK;`;
    const result = execFileSync("docker", ["exec", "-i", container!, "psql", "-U", "postgres", "-d", "postgres", "-qAt", "-v", "ON_ERROR_STOP=1"], { input: fixture, encoding: "utf8" }).trim().split("\n");
    expect(result).toEqual(["visible:own", "visible:home,own", "links:0", "shares:home=0.50,own=1.00", "links:1", "visible:own", "links:0"]);
  });
});
