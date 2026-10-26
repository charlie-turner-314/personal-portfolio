// @vitest-environment node
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
const container = process.env.OWNERSHIP_TEST_POSTGRES_CONTAINER;
const fixture = `BEGIN;
CREATE TEMP TABLE accounts(id text,user_id text,account_type text,is_active boolean,consolidated_into_account_id text);
CREATE TEMP TABLE people(id text,user_id text,kind text,linked_user_id text);
CREATE TEMP TABLE account_owners(account_id text,person_id text,share numeric);
CREATE TEMP TABLE account_ownership_allocations(account_id text,person_id text,effective_from date,share numeric);
CREATE TEMP TABLE household_memberships(member_user_id text,owner_user_id text);
CREATE TEMP TABLE household_account_shares(account_id text,member_user_id text,granted_by_user_id text);
CREATE TEMP TABLE account_balances(account_id text,date timestamp,balance_in_functional_currency numeric);
INSERT INTO accounts VALUES ('shared','owner','checking',true,NULL),('own','owner','savings',true,NULL),('missing','owner','checking',true,NULL),('private','other','checking',true,NULL),('loan','owner','mortgage',true,NULL);
INSERT INTO people VALUES ('self','owner','self','owner'),('partner','owner','member','other');
INSERT INTO account_ownership_allocations VALUES ('shared','self','1900-01-01',0.5),('shared','partner','1900-01-01',0.5);
INSERT INTO account_balances VALUES ('shared','2026-09-30',1000),('shared','2026-10-30',1400),('own','2026-09-30',500),('own','2026-10-30',700),('missing','2026-09-29',900),('missing','2026-10-30',1000),('private','2026-09-30',100000),('private','2026-10-30',200000);
`;
vi.mock("@/lib/db", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  return { db: drizzle(async (query: string, params: unknown[]) => {
    const literal = query.replace(/\$(\d+)/g, (_, n) => {
      const value = params[Number(n) - 1];
      return value === null ? "NULL" : typeof value === "boolean" ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
    });
    const wrapped = `SELECT COALESCE(json_agg(json_build_array(n,missing,change)),'[]') FROM (${literal}) rows(n,missing,change);`;
    const output = execFileSync("docker", ["exec","-i",process.env.OWNERSHIP_TEST_POSTGRES_CONTAINER!,"psql","-U","postgres","-d","postgres","-qAt","-v","ON_ERROR_STOP=1"],{input:fixture+wrapped+"ROLLBACK;",encoding:"utf8"});
    return { rows: JSON.parse(output.trim()) };
  }) };
});
vi.mock("@/lib/household/financial-auth",()=>({getAuthenticatedSession:async()=>({user:{id:"owner"}})}));
vi.mock("@/lib/data/cached",()=>({getCachedUserAccounts:vi.fn()}));
vi.mock("@/lib/api/investments",()=>({getPortfolio:vi.fn()}));
vi.mock("@/lib/actions/planned-expenses",()=>({getUpcomingPlannedExpenses:vi.fn()}));
import { getRecordedCashChange } from "./dashboard";
const from = new Date("2026-10-01"), to = new Date("2026-10-30T23:59:59Z");
describe.skipIf(!container)("recorded cash boundary balances",()=>{
  it("uses dated ownership and exact cash snapshots, excluding private accounts and debt",async()=>{
    expect(await getRecordedCashChange(from,to,["shared","own","private","loan"])).toEqual({recordedChange:400,missingAccounts:0});
    expect(await getRecordedCashChange(from,to,["shared"],"all")).toEqual({recordedChange:400,missingAccounts:0});
  },20_000);
  it("does not substitute an older snapshot or zero for a missing opening balance",async()=>{
    expect(await getRecordedCashChange(from,to)).toEqual({recordedChange:null,missingAccounts:1});
    expect(await getRecordedCashChange(from,new Date("2026-10-29"),["own"])).toEqual({recordedChange:null,missingAccounts:1});
  },20_000);
});
