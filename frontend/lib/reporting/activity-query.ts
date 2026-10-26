import { requireReportingCoverage } from "./coverage";
import { eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { categories, transactions, transactionLinks } from "@/lib/db/schema";
import { accountAccess } from "@/lib/household/account-access";
import { transactionAmountInReportingCurrency } from "@/lib/household/reporting-currency";
import { ownershipShareSql } from "@/lib/people/ownership-sql";
import { summarizeActivity } from "@/lib/dashboard/activity";

export interface ActivityBoundary {
  startDate:Date;
  endDate:Date;
  accountIds?:string[];
  /** undefined = My view; all = whole permitted records; UUID = selected identity. */
  personId?:string;
}

const field=(alias:string,name:string)=>sql`${sql.identifier(alias)}.${sql.identifier(name)}`;
const internalReference=(alias:string)=>sql`coalesce(${field(alias,"internal_transfer_id")},
  (SELECT automatic_link.id FROM internal_transfers automatic_link WHERE automatic_link.mirror_txn_id=${field(alias,"id")}))`;

/** This is a record boundary, not an importing-user boundary. It is evaluated
 * live in every query, including every linked peer used in a calculation.
 */
export function activityRecordBoundary(alias:string,actor:string,boundary:ActivityBoundary):SQL {
  const ids=[...new Set(boundary.accountIds?.filter(Boolean)??[])];
  return sql`${accountAccess(field(alias,"account_id"),actor)}
    AND (${field(alias,"include_in_analytics")}=true OR ${internalReference(alias)} IS NOT NULL)
    AND ${field(alias,"booked_at")}>=${boundary.startDate.toISOString()}::timestamp
    AND ${field(alias,"booked_at")}<=${boundary.endDate.toISOString()}::timestamp
    ${ids.length?sql`AND ${field(alias,"account_id")} IN (${sql.join(ids.map(id=>sql`${id}`),sql`, `)})`:sql``}`;
}

function effectiveCategoryType(alias:string,categoryAlias:string):SQL {
  return sql`CASE WHEN ${field(alias,"cash_flow_parts")} IS NULL
    AND coalesce(${field(alias,"cash_flow_kind")},${field(categoryAlias,"cash_flow_kind")}) IS NULL
    AND ${internalReference(alias)} IS NOT NULL THEN 'transfer' ELSE ${field(categoryAlias,"category_type")} END`;
}

export async function fetchFinancialActivityRows(actor:string,boundary:ActivityBoundary) {
  const scope=boundary.personId==="all"?undefined:boundary.personId??{userId:actor};
  // Materialize the permitted record set once. Every peer lookup below uses
  // this same boundary, and ownership/FX are evaluated once per bank record.
  const records=db.$with("financial_records").as(db.select({
    id:transactions.id,
    accountId:transactions.accountId,
    bookedAt:transactions.bookedAt,
    cashFlowKind:sql<string|null>`coalesce(${transactions.cashFlowKind},${categories.cashFlowKind})`.as("effective_kind"),
    cashFlowParts:transactions.cashFlowParts,
    nativeAmount:sql`${transactions.amount}`.as("native_amount"),
    categoryId:sql`${categories.id}`.as("category_id"),
    categoryName:sql`${categories.name}`.as("category_name"),
    categoryType:effectiveCategoryType("transactions","categories").as("category_type"),
    icon:categories.icon,color:categories.color,
    groupId:sql`${transactionLinks.groupId}`.as("group_id"),
    linkRole:sql`${transactionLinks.linkRole}`.as("link_role"),
    internalReference:internalReference("transactions").as("internal_reference"),
    economicShare:ownershipShareSql(scope,sql`transactions.account_id`,sql`transactions.booked_at`).as("economic_share"),
    reportingAmount:transactionAmountInReportingCurrency("transactions",actor).as("reporting_amount"),
    merchant:sql<string|null>`CASE WHEN EXISTS(SELECT 1 FROM internal_transfers generated WHERE generated.mirror_txn_id=${transactions.id}) THEN NULL ELSE ${transactions.merchant} END`.as("safe_merchant"),
    description:sql<string|null>`CASE WHEN EXISTS(SELECT 1 FROM internal_transfers generated WHERE generated.mirror_txn_id=${transactions.id}) THEN 'Transfer' ELSE ${transactions.description} END`.as("safe_description"),
    recurringName:sql<string|null>`(SELECT name FROM recurring_transactions personal_rule WHERE personal_rule.id=${transactions.recurringTransactionId} AND personal_rule.user_id=${actor})`.as("recurring_name"),
    recurrenceKnown:sql<boolean>`${transactions.userId}=${actor}`.as("recurrence_known"),
  }).from(transactions)
    .leftJoin(categories,sql`${categories.id}=coalesce(${transactions.categoryId},${transactions.categorySystemId})`)
    .leftJoin(transactionLinks,eq(transactions.id,transactionLinks.transactionId))
    .where(activityRecordBoundary("transactions",actor,boundary)));
  const r=(name:string)=>field("financial_records",name);
  const weighted=(alias:string)=>sql`CASE WHEN ${field(alias,"economic_share")}=0 THEN 0 ELSE ${field(alias,"reporting_amount")}*${field(alias,"economic_share")} END`;
  return db.with(records).select({
    date:sql<string>`to_char(${r("booked_at")},'YYYY-MM-DD')`,
    cashFlowKind:sql<string|null>`${r("effective_kind")}`,
    cashFlowParts:sql<import("@/lib/dashboard/cash-flow").CashFlowPortion[]|null>`${r("cash_flow_parts")}`,
    nativeAmount:sql<string>`${r("native_amount")}`,
    transferGroupId:sql<string|null>`CASE WHEN NOT EXISTS(
      SELECT 1 FROM financial_records peer WHERE peer.group_id=${r("group_id")}
        AND (peer.category_type IS DISTINCT FROM 'transfer' OR peer.cash_flow_parts IS NOT NULL OR peer.effective_kind IS NOT NULL)
      ) THEN coalesce(${r("group_id")}::text,${r("internal_reference")}::text,'unlinked:'||${r("id")}::text) END`,
    transferAmount:sql<string|null>`${weighted("financial_records")}`,
    categoryId:sql<string|null>`${r("category_id")}`,
    categoryName:sql<string|null>`${r("category_name")}`,
    categoryType:sql<string|null>`${r("category_type")}`,
    icon:sql<string|null>`${r("icon")}`,color:sql<string|null>`${r("color")}`,
    amount:sql<string|null>`CASE
      WHEN ${r("cash_flow_parts")} IS NOT NULL OR ${r("effective_kind")} IN ('investment','loan_principal')
        OR EXISTS(SELECT 1 FROM financial_records allocation_peer WHERE allocation_peer.group_id=${r("group_id")}
          AND (allocation_peer.cash_flow_parts IS NOT NULL OR allocation_peer.effective_kind IN ('investment','loan_principal')))
        THEN ${weighted("financial_records")}
      WHEN ${r("link_role")}='primary' AND ${r("group_id")} IS NOT NULL THEN (
        SELECT CASE WHEN count(*) FILTER(WHERE t2.reporting_amount IS NULL AND t2.economic_share>0)>0
          THEN NULL ELSE sum(${weighted("t2")}) END FROM financial_records t2 WHERE t2.group_id=${r("group_id")})
      WHEN ${r("link_role")} IS NOT NULL AND EXISTS(SELECT 1 FROM financial_records primary_record
        WHERE primary_record.group_id=${r("group_id")} AND primary_record.link_role='primary') THEN 0
      ELSE ${weighted("financial_records")} END`,
    transferFullAmount:sql<string|null>`${r("reporting_amount")}`,
    transactionId:sql<string>`${r("id")}`,accountId:sql<string>`${r("account_id")}`,
    merchant:sql<string|null>`${r("safe_merchant")}`,description:sql<string|null>`${r("safe_description")}`,
    recurringName:sql<string|null>`${r("recurring_name")}`,recurrenceKnown:sql<boolean>`${r("recurrence_known")}`,
  }).from(records);
}

export async function fetchFinancialActivity(actor:string,boundary:ActivityBoundary) {
  const coverage=await requireReportingCoverage(actor,boundary.accountIds);
  return {...summarizeActivity(await fetchFinancialActivityRows(actor,boundary)),coverage};
}
