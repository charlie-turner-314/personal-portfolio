import { sql, type SQL } from "drizzle-orm";
import { convertReportingAmount } from "@/lib/household/reporting-currency";

/** End-of-day estimate. Only subsequent activity changes a recorded anchor.
 * Each movement is converted in its original currency on its own booking date.
 * Unknown amounts remain unknown until a later usable observation resets them.
 */
export function nativeBalanceEstimate(accountId:string, currency:string|null, startingBalance:number|string, day:string|SQL, excludeTransactionId?:string|readonly string[]):SQL<string|null> {
  const excluded=typeof excludeTransactionId === "string" ? [excludeTransactionId] : excludeTransactionId??[];
  const amount=convertReportingAmount(sql`t.amount`,sql`t.currency`,sql`${currency}`,sql`t.booked_at`);
  return sql`(SELECT CASE WHEN anchor.date IS NOT NULL AND anchor.value IS NULL THEN NULL
      WHEN count(*) FILTER(WHERE activity.id IS NOT NULL AND converted IS NULL)>0 THEN NULL
      ELSE coalesce(anchor.value,${startingBalance})+coalesce(sum(converted),0) END
      FROM (SELECT 1) seed LEFT JOIN LATERAL (
        SELECT ab.date, ${convertReportingAmount(sql`ab.balance_in_account_currency`,sql`coalesce(ab.account_currency,${currency})`,sql`${currency}`,sql`ab.date`)} value
        FROM account_balances ab WHERE ab.account_id=${accountId} AND ab.balance_source<>'calculated'
          AND ab.date::date<=${day}::date ORDER BY ab.date DESC LIMIT 1
      ) anchor ON true LEFT JOIN LATERAL (
        SELECT t.id, ${amount} converted FROM transactions t WHERE t.account_id=${accountId}
          AND t.booked_at::date<=${day}::date AND (anchor.date IS NULL OR t.booked_at::date>anchor.date::date)
          ${excluded.length ? sql`AND t.id NOT IN (${sql.join(excluded.map(id=>sql`${id}`),sql`, `)})` : sql``}
      ) activity ON true GROUP BY anchor.date,anchor.value)`;
}
