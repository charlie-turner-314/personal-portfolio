"use server";

import { requireAuth } from "@/lib/household/financial-auth";
import { fetchFinancialActivity } from "@/lib/reporting/activity-query";
import { getTransactionsPage } from "@/lib/actions/transactions";
import { parseTransactionsSearchParams } from "@/lib/transactions/query-state";
export { getTotalBalance } from "./dashboard";

/** Legacy consumer adapter uses the same purposes, shares and currency as reports. */
export async function getTransactionSummary(days = 30, personId?: string) {
  const actor = await requireAuth();
  if (!actor) return [];
  const endDate = new Date();
  const startDate = new Date(endDate);
  const periodDays = Math.max(1, Number.isFinite(days) ? Math.floor(days) : 30);
  startDate.setDate(startDate.getDate() - periodDays);
  const activity = await fetchFinancialActivity(actor, { startDate, endDate, personId });
  if (activity.missingConversions) {
    throw new Error("This summary is unavailable while currency conversions are missing");
  }
  return activity.dailyData;
}

export async function getRecentTransactions(limit = 5, personId?: string) {
  const count = Math.max(1, Math.min(100, Number.isFinite(limit) ? Math.floor(limit) : 5));
  const page = await getTransactionsPage({
    ...parseTransactionsSearchParams({}), pageSize: count, personId,
  });
  return page.rows;
}
