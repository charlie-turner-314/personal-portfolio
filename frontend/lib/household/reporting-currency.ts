import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/** Historical conversion uses only rates recorded on/before the observation.
 * Missing rates stay NULL; they are never a zero financial amount.
 */
export function convertReportingAmount(amount: SQLWrapper, source: SQLWrapper, target: SQLWrapper, asOf: SQLWrapper): SQL<string | null> {
  return sql<string | null>`CASE WHEN (${amount}) IS NULL THEN NULL WHEN (${source})=(${target}) THEN (${amount})
    ELSE (${amount})*coalesce(
      (SELECT rate FROM exchange_rates fx WHERE fx.base_currency=(${source}) AND fx.target_currency=(${target})
        AND fx.rate>0 AND fx.date::date<=(${asOf})::date ORDER BY fx.date DESC LIMIT 1),
      (SELECT 1/nullif(rate,0) FROM exchange_rates fx WHERE fx.base_currency=(${target}) AND fx.target_currency=(${source})
        AND fx.rate>0 AND fx.date::date<=(${asOf})::date ORDER BY fx.date DESC LIMIT 1)) END`;
}

export function reportingCurrencyForUser(userId: string | SQL): SQL {
  return sql`coalesce((SELECT functional_currency FROM users reporting_user WHERE reporting_user.id=${userId}),'EUR')`;
}

/** functional_amount is denominated in the custodian's currency, not necessarily
 * the viewer's. Native currency wins when it already matches the viewer.
 */
export function transactionAmountInReportingCurrency(alias: string, actorUserId: string): SQL<string | null> {
  const field = (name:string)=>sql`${sql.identifier(alias)}.${sql.identifier(name)}`;
  const target = reportingCurrencyForUser(actorUserId);
  const functionalSource = reportingCurrencyForUser(field("user_id"));
  const native = convertReportingAmount(field("amount"),field("currency"),target,field("booked_at"));
  const functional = convertReportingAmount(field("functional_amount"),functionalSource,target,field("booked_at"));
  return sql<string | null>`CASE WHEN ${field("currency")}=${target} THEN ${field("amount")}
    WHEN ${functionalSource}=${target} AND ${field("functional_amount")} IS NOT NULL THEN ${field("functional_amount")}
    ELSE coalesce(${native},${functional}) END`;
}

export function snapshotBalanceInReportingCurrency(balanceAlias:string,accountAlias:string,actor:string):SQL<string|null> {
  const field=(alias:string,name:string)=>sql`${sql.identifier(alias)}.${sql.identifier(name)}`;
  const target=reportingCurrencyForUser(actor);
  const source=reportingCurrencyForUser(field(accountAlias,"user_id"));
  const native=convertReportingAmount(field(balanceAlias,"balance_in_account_currency"),field(accountAlias,"currency"),target,field(balanceAlias,"date"));
  const functional=convertReportingAmount(field(balanceAlias,"balance_in_functional_currency"),source,target,field(balanceAlias,"date"));
  return sql<string|null>`CASE WHEN ${field(accountAlias,"currency")}=${target} THEN ${field(balanceAlias,"balance_in_account_currency")}
    WHEN ${source}=${target} THEN ${field(balanceAlias,"balance_in_functional_currency")}
    ELSE coalesce(${native},${functional}) END`;
}
