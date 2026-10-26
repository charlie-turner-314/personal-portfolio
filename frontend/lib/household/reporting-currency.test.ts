// @vitest-environment node
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { transactionAmountInReportingCurrency } from "./reporting-currency";
const container = process.env.OWNERSHIP_TEST_POSTGRES_CONTAINER;
describe.skipIf(!container)("actor/date-aware reporting currency on PostgreSQL",()=>{
  it("does not relabel a partner's functional amount and keeps missing/future conversions unknown",()=>{
    const query=new PgDialect().sqlToQuery(sql`SELECT id || '=' || coalesce((${transactionAmountInReportingCurrency("t","viewer")})::numeric(18,2)::text,'unknown') FROM transactions t ORDER BY id`);
    const statement=query.sql.replace(/\$(\d+)/g,(_,n)=>`'${String(query.params[Number(n)-1]).replaceAll("'","''")}'`);
    const fixture=`BEGIN;
      CREATE TEMP TABLE users(id text,functional_currency text);
      CREATE TEMP TABLE transactions(id text,user_id text,amount numeric,functional_amount numeric,currency text,booked_at timestamp);
      CREATE TEMP TABLE exchange_rates(base_currency text,target_currency text,rate numeric,date timestamp);
      INSERT INTO users VALUES('viewer','AUD'),('partner','EUR');
      INSERT INTO exchange_rates VALUES('EUR','AUD',2,'2026-01-01'),('USD','AUD',1.5,'2026-01-01'),('NZD','AUD',.9,'2030-01-01'),('CAD','AUD',0,'2026-01-01');
      INSERT INTO transactions VALUES
        ('native','partner',100,50,'AUD','2026-06-01'),
        ('foreign','partner',100,60,'USD','2026-06-01'),
        ('functional-fallback','partner',100,50,'JPY','2026-06-01'),
        ('missing','partner',100,NULL,'GBP','2026-06-01'),
        ('future','partner',100,NULL,'NZD','2026-06-01'),
        ('invalid-zero-rate','partner',100,NULL,'CAD','2026-06-01'),
        ('refund','partner',-100,-50,'AUD','2026-06-01');
      ${statement};ROLLBACK;`;
    const result=execFileSync("docker",["exec","-i",container!,"psql","-U","postgres","-d","postgres","-qAt","-v","ON_ERROR_STOP=1"],{input:fixture,encoding:"utf8"});
    expect(result.trim().split("\n")).toEqual(['foreign=150.00','functional-fallback=100.00','future=unknown','invalid-zero-rate=unknown','missing=unknown','native=100.00','refund=-100.00']);
  });
});
