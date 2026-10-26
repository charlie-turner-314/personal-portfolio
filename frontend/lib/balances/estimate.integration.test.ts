// @vitest-environment node
import { execFileSync } from "node:child_process";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { nativeBalanceEstimate } from "./estimate";

it.skipIf(!process.env.OWNERSHIP_TEST_POSTGRES_CONTAINER)("preserves anchor units, dates and missing FX in actual PostgreSQL",()=>{
  const estimate=(day:string,excluded?:string)=>{
    const query=new PgDialect().sqlToQuery(sql`SELECT ${nativeBalanceEstimate("cash","AUD",100,day,excluded)}`);
    return query.sql.replace(/\$(\d+)/g,(_,n)=>`'${String(query.params[Number(n)-1]).replaceAll("'","''")}'`)+";";
  };
  const fixture=`BEGIN;
    CREATE TEMP TABLE account_balances(account_id text,date timestamp,balance_in_account_currency numeric,account_currency text,balance_source text);
    CREATE TEMP TABLE transactions(id text,account_id text,booked_at timestamp,amount numeric,currency text);
    CREATE TEMP TABLE exchange_rates(date timestamp,base_currency text,target_currency text,rate numeric);
    INSERT INTO transactions VALUES('a','cash','2026-01-01',10,'USD'),('b','cash','2026-01-02',10,'USD'),('c','cash','2026-01-03',10,'XXX');
    INSERT INTO exchange_rates VALUES('2026-01-01','USD','AUD',2),('2026-01-02','USD','AUD',3);
    ${estimate("2026-01-01")}${estimate("2026-01-02")}${estimate("2026-01-02","b")}${estimate("2026-01-03")}
    INSERT INTO account_balances VALUES('cash','2026-01-03',500,'AUD','statement');
    ${estimate("2026-01-03")}${estimate("2026-01-04")}
    UPDATE account_balances SET balance_in_account_currency=NULL;
    ${estimate("2026-01-04")}
    ROLLBACK;`;
  const result=execFileSync("docker",["exec","-i",process.env.OWNERSHIP_TEST_POSTGRES_CONTAINER!,"psql","-U","postgres","-d","postgres","-qAt","-v","ON_ERROR_STOP=1"],{input:fixture,encoding:"utf8"});
  expect(result.trimEnd().split("\n")).toEqual(["120","150","120","","500","500"]);
  // Final NULL is a blank row, retained separately from trimEnd above.
  expect(result.endsWith("500\n\n")).toBe(true);
},20_000);
