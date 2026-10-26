import { and,eq,sql } from "drizzle-orm";
import { accounts } from "@/lib/db/schema";
import { accountAccess } from "@/lib/household/account-access";
import { convertReportingAmount,reportingCurrencyForUser } from "@/lib/household/reporting-currency";
import type { HouseholdTransaction } from "@/lib/household/transaction";
import { nativeBalanceEstimate } from "./estimate";

/** Refresh only derived estimates under the caller's lifecycle transaction.
 * Supplied/legacy observations reset subsequent estimates and remain intact.
 * One SQL batch avoids holding the permission lock across thousands of trips.
 */
export async function refreshAccountBalances(
  tx:HouseholdTransaction, actor:string, accountId:string, fromDate:Date,
  startingBalance:number, excludeTransactionId?:string,
):Promise<void> {
  const account=await tx.query.accounts.findFirst({where:and(eq(accounts.id,accountId),accountAccess(accounts.id,actor))});
  if(!account) throw new Error("Account no longer available");
  const currency=reportingCurrencyForUser(account.userId);
  const native=nativeBalanceEstimate(accountId,account.currency,startingBalance,sql`balance_days.day`,excludeTransactionId);
  const functional=convertReportingAmount(sql`estimate.value`,sql`${account.currency}`,currency,sql`balance_days.day`);
  await tx.execute(sql`INSERT INTO account_balances(account_id,date,balance_in_account_currency,balance_in_functional_currency,balance_source,account_currency,functional_currency)
    SELECT ${accountId}::uuid,balance_days.day,estimate.value,${functional},'calculated',${account.currency},${currency}
    FROM generate_series(${fromDate.toISOString().slice(0,10)}::date,CURRENT_DATE,interval '1 day') balance_days(day)
    CROSS JOIN LATERAL (SELECT ${native} AS value) estimate
    WHERE ${accountAccess(sql`${accountId}::uuid`,actor)}
      AND NOT EXISTS(SELECT 1 FROM account_balances recorded WHERE recorded.account_id=${accountId}::uuid
        AND recorded.date::date=balance_days.day::date AND recorded.balance_source<>'calculated')
    ON CONFLICT(account_id,date) DO UPDATE SET
      balance_in_account_currency=excluded.balance_in_account_currency,
      balance_in_functional_currency=excluded.balance_in_functional_currency,
      account_currency=excluded.account_currency,functional_currency=excluded.functional_currency,updated_at=now()
    WHERE account_balances.balance_source='calculated' AND
      (account_balances.balance_in_account_currency,account_balances.balance_in_functional_currency,account_balances.account_currency,account_balances.functional_currency)
      IS DISTINCT FROM (excluded.balance_in_account_currency,excluded.balance_in_functional_currency,excluded.account_currency,excluded.functional_currency)`);
  const current=nativeBalanceEstimate(accountId,account.currency,account.startingBalance??"0",sql`CURRENT_DATE`);
  await tx.update(accounts).set({functionalBalance:convertReportingAmount(current,sql`${account.currency}`,currency,sql`CURRENT_DATE`),updatedAt:new Date()})
    .where(and(eq(accounts.id,accountId),accountAccess(accounts.id,actor)));
}
