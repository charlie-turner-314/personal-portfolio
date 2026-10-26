import { sql } from "drizzle-orm";
import { ownershipShareSql } from "@/lib/people/ownership-sql";
import { transactionAmountInReportingCurrency } from "@/lib/household/reporting-currency";

/** Attribution never replaces the original bank amount or grants access. */
export function transactionReportingValue(actor:string,personId?:string,alias="transactions") {
  const scope=personId==="all"?undefined:personId??{userId:actor};
  const share=sql<string>`${ownershipShareSql(scope,sql`${sql.identifier(alias)}.account_id`,sql`${sql.identifier(alias)}.booked_at`)}`;
  const whole=transactionAmountInReportingCurrency(alias,actor);
  const amount=sql<string|null>`CASE WHEN (${share})=0 THEN 0 ELSE (${whole})*(${share}) END`;
  return {share,whole,amount};
}
