"use server";

import { accountAccess, propertyAccess } from "@/lib/household/account-access";
import { db } from "@/lib/db";
import { accounts, transactions, categories, users, properties, vehicles, transactionLinks, superAccounts } from "@/lib/db/schema";
import { getAuthenticatedSession } from "@/lib/household/financial-auth";
import { getCachedUserAccounts } from "@/lib/data/cached";
import { eq, sql, gte, lte, and, desc, inArray, isNull } from "drizzle-orm";
import { summarizeActivity, activitySankey, cashFlowMetrics } from "@/lib/dashboard/activity";
import {
  buildIncomeExpenseBuckets,
  resolveIncomeExpenseGrouping,
  type IncomeExpenseGrouping,
} from "@/lib/dashboard/income-expense-buckets";
import { ownershipShareSql, propertyOwnershipShareSql } from "@/lib/people/ownership-sql";
import { getOwnersForEntities } from "@/lib/people/queries";
import { attributeAmount } from "@/lib/people/attribution";
import { getPortfolio } from "@/lib/api/investments";
import { getUpcomingPlannedExpenses } from "@/lib/actions/planned-expenses";
import {
  calculateNetWorthOverview,
  emptyNetWorthOverview,
  type NetWorthEntry,
  type NetWorthOverview,
} from "@/lib/net-worth/calculation";
import { getAustralianFinancialYearLabelForDateRange } from "@/lib/dates/australian-financial-year";
import { CASH_ACCOUNT_TYPE_VALUES } from "@/lib/constants/account-types";

async function getUserCurrency(userId: string): Promise<string> {
  const result = await db
    .select({ functionalCurrency: users.functionalCurrency })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return result[0]?.functionalCurrency || "EUR";
}

function normalizeAccountIds(accountIds?: string[]): string[] | undefined {
  if (!accountIds?.length) return undefined;
  const uniqueIds = Array.from(new Set(accountIds.map((id) => id.trim()).filter(Boolean)));
  return uniqueIds.length > 0 ? uniqueIds : undefined;
}

const t2AccountId = sql.raw("t2.account_id");
const t2BookedAt = sql.raw("t2.booked_at");

async function getLatestTransactionDate(userId: string, accountIds?: string[]): Promise<Date> {
  const normalizedAccountIds = normalizeAccountIds(accountIds);
  const conditions = [accountAccess(transactions.accountId, userId)];
  if (normalizedAccountIds?.length) {
    conditions.push(inArray(transactions.accountId, normalizedAccountIds));
  }

  const result = await db
    .select({
      latestDate: sql<string>`MAX(${transactions.bookedAt})`,
    })
    .from(transactions)
    .where(and(...conditions));

  const latestDate = result[0]?.latestDate;
  return latestDate ? new Date(latestDate) : new Date();
}

// Get user accounts for filter dropdown
export async function getUserAccounts() {
  return getCachedUserAccounts();
}

// Get available months/years for the date selector
export async function getAvailableMonths() {
  const session = await getAuthenticatedSession();

  if (!session?.user?.id) {
    return [];
  }

  const result = await db
    .select({
      year: sql<number>`EXTRACT(YEAR FROM ${transactions.bookedAt})::int`,
      month: sql<number>`EXTRACT(MONTH FROM ${transactions.bookedAt})::int`,
    })
    .from(transactions)
    .where(accountAccess(transactions.accountId, session.user.id))
    .groupBy(
      sql`EXTRACT(YEAR FROM ${transactions.bookedAt})`,
      sql`EXTRACT(MONTH FROM ${transactions.bookedAt})`
    )
    .orderBy(
      desc(sql`EXTRACT(YEAR FROM ${transactions.bookedAt})`),
      desc(sql`EXTRACT(MONTH FROM ${transactions.bookedAt})`)
    );

  return result.map((row) => ({
    year: row.year,
    month: row.month,
  }));
}

/** Cash available in bank/cash accounts; liabilities and investments are separate. */
export async function getTotalBalance(accountIds?: string[], personId?: string) {
  const session = await getAuthenticatedSession();
  if (!session?.user?.id) return { total: 0, currency: "EUR" };

  const ownershipScope = personId === "all" ? undefined : personId ?? {
    userId: session.user.id, householdPersonId: session.householdPersonId,
  };
  const conditions = [
    accountAccess(accounts.id, session.user.id),
    eq(accounts.isActive, true),
    inArray(accounts.accountType, [...CASH_ACCOUNT_TYPE_VALUES]),
  ];
  const normalizedAccountIds = normalizeAccountIds(accountIds);
  if (normalizedAccountIds?.length) conditions.push(inArray(accounts.id, normalizedAccountIds));

  // New manual accounts may not have daily snapshots yet. Their current
  // functional balance is authoritative until a snapshot is available.
  const balance = sql`COALESCE((
    SELECT ab.balance_in_functional_currency FROM account_balances ab
    WHERE ab.account_id = ${accounts.id} AND ab.date::date <= CURRENT_DATE
    ORDER BY ab.date DESC LIMIT 1
  ), ${accounts.functionalBalance}, 0)`;
  const share = ownershipShareSql(ownershipScope, accounts.id, sql`CURRENT_DATE`);
  const [result, currency] = await Promise.all([
    db.select({ total: sql<string>`COALESCE(SUM(${balance} * ${share}), 0)` })
      .from(accounts).where(and(...conditions)),
    getUserCurrency(session.user.id),
  ]);
  return { total: parseFloat(result[0]?.total || "0"), currency };
}

export async function getBalanceHistory(startDate: Date, endDate: Date, accountIds?: string[], personId?: string) {
  const session = await getAuthenticatedSession();
  if (!session?.user?.id) return [];

  const ownershipScope = personId === "all" ? undefined : personId ?? {
    userId: session.user.id, householdPersonId: session.householdPersonId,
  };
  const conditions = [
    accountAccess(accounts.id, session.user.id),
    eq(accounts.isActive, true),
    inArray(accounts.accountType, [...CASH_ACCOUNT_TYPE_VALUES]),
  ];
  const normalizedAccountIds = normalizeAccountIds(accountIds);
  if (normalizedAccountIds?.length) conditions.push(inArray(accounts.id, normalizedAccountIds));
  const day = sql`cash_days.day`;
  const share = ownershipShareSql(ownershipScope, accounts.id, day);

  // Carry each account's latest known balance forward independently, so an
  // account without a snapshot on a particular day does not disappear. Never
  // mix whole-portfolio net-worth snapshots into this cash-only series.
  const result = await db.select({
    date: sql<string>`TO_CHAR(${day}, 'YYYY-MM-DD')`,
    value: sql<string>`SUM(COALESCE(cash_balance.value,
      CASE WHEN ${day}::date = CURRENT_DATE THEN ${accounts.functionalBalance} END, 0) * ${share})`,
  }).from(accounts)
    .innerJoin(sql`generate_series(${startDate.toISOString()}::date,
      LEAST(${endDate.toISOString()}::date, CURRENT_DATE), interval '1 day') AS cash_days(day)`, sql`true`)
    .leftJoin(sql`LATERAL (
      SELECT ab.balance_in_functional_currency AS value FROM account_balances ab
      WHERE ab.account_id = ${accounts.id} AND ab.date::date <= ${day}::date
      ORDER BY ab.date DESC LIMIT 1
    ) AS cash_balance`, sql`true`)
    .where(and(...conditions, sql`(cash_balance.value IS NOT NULL OR ${day}::date = CURRENT_DATE)`))
    .groupBy(day).orderBy(day);

  return result.map(row => ({ date: row.date, value: parseFloat(row.value || "0") }));
}

// All activity widgets share classification and linked-transaction semantics.
// A LEFT JOIN is essential: categorization enriches activity, never gates it.
async function getActivitySummary(startDate: Date, endDate: Date, accountIds?: string[], personId?: string) {
  const session = await getAuthenticatedSession();
  if (!session?.user?.id) return summarizeActivity([]);
  const ownershipScope = personId === "all" ? undefined : personId ?? {
    userId: session.user.id, householdPersonId: session.householdPersonId,
  };
  const normalizedAccountIds = normalizeAccountIds(accountIds);
  const conditions = [
    accountAccess(transactions.accountId, session.user.id),
    eq(transactions.includeInAnalytics, true),
    isNull(transactions.internalTransferId),
    gte(transactions.bookedAt, startDate),
    lte(transactions.bookedAt, endDate),
  ];
  if (normalizedAccountIds?.length) conditions.push(inArray(transactions.accountId, normalizedAccountIds));
  const userCurrency = sql`COALESCE((SELECT functional_currency FROM ${users} WHERE id = ${session.user.id}), 'EUR')`;
  const amountInCurrency = sql`COALESCE(${transactions.functionalAmount}, CASE WHEN ${transactions.currency} = ${userCurrency} THEN ${transactions.amount} END)`;
  const linkedAmountInCurrency = sql`COALESCE(t2.functional_amount, CASE WHEN t2.currency = ${userCurrency} THEN t2.amount END)`;
  const rows = await db.select({
    date: sql<string>`DATE(${transactions.bookedAt})`,
    cashFlowKind: sql<string | null>`COALESCE(${transactions.cashFlowKind}, ${categories.cashFlowKind})`,
    allocationFraction: sql<string | null>`CASE WHEN ${transactions.cashFlowAllocationAmount} IS NULL THEN 1
      ELSE ${transactions.cashFlowAllocationAmount} / NULLIF(ABS(${transactions.amount}), 0) END`,
    transferGroupId: sql<string | null>`CASE WHEN NOT EXISTS (
      SELECT 1 FROM ${transactionLinks} transfer_peer
      JOIN ${transactions} peer ON peer.id = transfer_peer.transaction_id
      LEFT JOIN ${categories} peer_category ON peer_category.id = COALESCE(peer.category_id, peer.category_system_id)
      WHERE transfer_peer.group_id = ${transactionLinks.groupId}
        AND ${accountAccess(sql.raw("peer.account_id"), session.user.id)}
        AND (peer_category.category_type IS DISTINCT FROM 'transfer'
          OR COALESCE(peer.cash_flow_kind, peer_category.cash_flow_kind) IS NOT NULL)
    ) THEN ${transactionLinks.groupId} END`,
    transferAmount: sql<string | null>`${amountInCurrency} * ${ownershipShareSql(ownershipScope, transactions.accountId, transactions.bookedAt)}`,
    categoryId: categories.id,
    categoryName: categories.name,
    categoryType: categories.categoryType,
    icon: categories.icon,
    color: categories.color,
    amount: sql<string | null>`CASE
      WHEN COALESCE(${transactions.cashFlowKind}, ${categories.cashFlowKind}) IN ('investment', 'loan_principal')
        THEN ${amountInCurrency} * ${ownershipShareSql(ownershipScope, transactions.accountId, transactions.bookedAt)}
      WHEN ${transactionLinks.linkRole} = 'primary' AND ${transactionLinks.groupId} IS NOT NULL THEN
        (
          SELECT CASE WHEN COUNT(*) FILTER (WHERE ${linkedAmountInCurrency} IS NULL) > 0 THEN NULL
            ELSE SUM(${linkedAmountInCurrency} * ${ownershipShareSql(ownershipScope, t2AccountId, t2BookedAt)}) END
          FROM ${transactions} t2
          JOIN ${transactionLinks} tl2 ON t2.id = tl2.transaction_id
          WHERE tl2.group_id = ${transactionLinks.groupId}
            AND ${accountAccess(t2AccountId, session.user.id)}
            AND t2.include_in_analytics = true
            AND t2.internal_transfer_id IS NULL
        )
      WHEN ${transactionLinks.linkRole} IS NOT NULL THEN 0
      ELSE ${amountInCurrency} * ${ownershipShareSql(ownershipScope, transactions.accountId, transactions.bookedAt)}
    END`,
  }).from(transactions)
    .leftJoin(categories, sql`${categories.id} = COALESCE(${transactions.categoryId}, ${transactions.categorySystemId})`)
    .leftJoin(transactionLinks, eq(transactions.id, transactionLinks.transactionId))
    .where(and(...conditions));
  return summarizeActivity(rows);
}

export async function getPeriodSpending(startDate: Date, endDate: Date, accountIds?: string[], personId?: string) {
  const session = await getAuthenticatedSession();
  const [activity, currency] = await Promise.all([
    getActivitySummary(startDate, endDate, accountIds, personId),
    session?.user?.id ? getUserCurrency(session.user.id) : Promise.resolve("EUR"),
  ]);
  return { total: activity.expenses, currency };
}

export async function getPeriodIncome(startDate: Date, endDate: Date, accountIds?: string[], personId?: string) {
  const session = await getAuthenticatedSession();
  const [activity, currency] = await Promise.all([
    getActivitySummary(startDate, endDate, accountIds, personId),
    session?.user?.id ? getUserCurrency(session.user.id) : Promise.resolve("EUR"),
  ]);
  return { total: activity.income, currency };
}

export async function getSpendingHistory(startDate: Date, endDate: Date, accountIds?: string[], personId?: string) {
  return (await getActivitySummary(startDate, endDate, accountIds, personId)).dailyData
    .map((day) => ({ date: day.date, value: day.expenses }));
}

export async function getIncomeHistory(startDate: Date, endDate: Date, accountIds?: string[], personId?: string) {
  return (await getActivitySummary(startDate, endDate, accountIds, personId)).dailyData
    .map((day) => ({ date: day.date, value: day.income }));
}

export async function getIncomeExpenseData(startDate: Date, endDate: Date, accountIds?: string[], grouping?: IncomeExpenseGrouping, personId?: string) {
  const activity = await getActivitySummary(startDate, endDate, accountIds, personId);
  return buildIncomeExpenseBuckets({ startDate, endDate, grouping, dailyData: activity.dailyData });
}

export async function getSpendingByCategory(startDate: Date, endDate: Date, accountIds?: string[], limit: number = 5, personId?: string) {
  const activity = await getActivitySummary(startDate, endDate, accountIds, personId);
  return {
    categories: activity.categories.filter((category) => category.type === "expense").slice(0, limit),
    total: activity.expenses,
  };
}

export async function getAssetsOverview(accountIds?: string[], personId?: string): Promise<NetWorthOverview> {
  const session = await getAuthenticatedSession();

  if (!session?.user?.id) {
    return emptyNetWorthOverview();
  }

  const [userAccounts, userProperties, userVehicles, currency, portfolio] = await Promise.all([
    db
      .select({
        id: accounts.id,
        name: accounts.name,
        accountType: accounts.accountType,
        institution: accounts.institution,
        functionalBalance: accounts.functionalBalance,
        startingBalance: accounts.startingBalance,
        currency: accounts.currency,
        superAccountId: superAccounts.id,
        includeSuperInNetWorth: superAccounts.includeInNetWorth,
        ownershipShare: ownershipShareSql(personId, accounts.id, sql`CURRENT_DATE`),
      })
      .from(accounts)
      .leftJoin(
        superAccounts,
        and(
          eq(superAccounts.accountId, accounts.id),
          accountAccess(superAccounts.accountId, session.user.id),
        ),
      )
      .where(and(accountAccess(accounts.id, session.user.id), eq(accounts.isActive, true))),
    db
      .select({
        id: properties.id,
        name: properties.name,
        propertyType: properties.propertyType,
        address: properties.address,
        currentValue: properties.currentValue,
        currency: properties.currency,
        ownershipShare: propertyOwnershipShareSql(personId, properties.id),
      })
      .from(properties)
      .where(and(propertyAccess(properties.id, session.user.id), eq(properties.isActive, true))),
    db
      .select({
        id: vehicles.id,
        name: vehicles.name,
        vehicleType: vehicles.vehicleType,
        make: vehicles.make,
        model: vehicles.model,
        year: vehicles.year,
        currentValue: vehicles.currentValue,
        currency: vehicles.currency,
      })
      .from(vehicles)
      .where(and(eq(vehicles.userId, session.user.id), eq(vehicles.isActive, true))),
    getUserCurrency(session.user.id),
    getPortfolio().catch(() => null),
  ]);

  const [propertyOwners, vehicleOwners] = personId ? await Promise.all([
    getOwnersForEntities("property", userProperties.map((property) => property.id)),
    getOwnersForEntities("vehicle", userVehicles.map((vehicle) => vehicle.id)),
  ]) : [new Map(), new Map()];
  const selectedIds = normalizeAccountIds(accountIds);
  const portfolioById = new Map((portfolio?.accounts || []).map((account) => [account.id, account]));
  const entries: NetWorthEntry[] = [
    ...userAccounts
      .filter((account) => !selectedIds || selectedIds.includes(account.id))
      .map((account) => ({
        id: account.id,
        name: account.name,
        institution: account.institution,
        // Portfolio holdings replace, rather than duplicate, the same account balance.
        value: Number(portfolioById.get(account.id)?.value ?? account.functionalBalance ?? 0) * Number(account.ownershipShare),
        currency,
        source: "account" as const,
        accountType: account.accountType,
        isSuperannuation: account.superAccountId !== null,
        includeInNetWorth: account.includeSuperInNetWorth,
      })),
    ...(selectedIds ? [] : userProperties.map((property) => ({
      id: property.id,
      name: property.name,
      institution: property.address,
      value: property.ownershipShare === undefined
        ? attributeAmount(Number(property.currentValue || 0), propertyOwners.get(property.id) || [], personId || null)
        : Number(property.currentValue || 0) * Number(property.ownershipShare),
      currency: property.currency || currency,
      source: "property" as const,
    }))),
    ...(selectedIds ? [] : userVehicles.map((vehicle) => ({
      id: vehicle.id,
      name: vehicle.name,
      institution: [vehicle.make, vehicle.model].filter(Boolean).join(" ") || null,
      value: attributeAmount(Number(vehicle.currentValue || 0), vehicleOwners.get(vehicle.id) || [], personId || null),
      currency: vehicle.currency || currency,
      source: "vehicle" as const,
    }))),
  ];

  return {
    ...calculateNetWorthOverview(entries, currency),
    scope: personId ? "Selected person’s share of visible accounts" : "Your visible finances",
    accountFiltered: Boolean(selectedIds),
  };
}

export interface SankeyData {
  nodes: {
    name: string;
    categoryId?: string | null;
    categoryType?: "income" | "expense";
    total?: number;
  }[];
  links: { source: number; target: number; value: number }[];
}

export async function getSankeyData(startDate?: Date, endDate?: Date, accountIds?: string[], personId?: string): Promise<SankeyData> {
  const session = await getAuthenticatedSession();
  if (!session?.user?.id) return { nodes: [], links: [] };
  let rangeStart = startDate;
  let rangeEnd = endDate;
  if (!rangeStart || !rangeEnd) {
    rangeEnd = new Date(await getLatestTransactionDate(session.user.id, accountIds));
    rangeEnd.setHours(23, 59, 59, 999);
    rangeStart = new Date(rangeEnd);
    rangeStart.setDate(rangeStart.getDate() - 29);
    rangeStart.setHours(0, 0, 0, 0);
  }
  return activitySankey(await getActivitySummary(rangeStart, rangeEnd, accountIds, personId));
}

export interface DashboardFilters {
  accountIds?: string[];
  personId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  horizon?: number;
}

export async function getDashboardData(filters: DashboardFilters = {}) {
  const session = await getAuthenticatedSession();

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  if (!session?.user?.id) {
    return {
      cashFlow: { savingsFromIncome: 0, investments: 0, loanPrincipal: 0, transfersIn: 0, transfersOut: 0, netReportedCashFlow: 0 },
      activityMissingConversions: 0,
      balance: { total: 0, currency: "EUR" },
      balanceHistory: [],
      periodSpending: { total: 0, currency: "EUR" },
      periodIncome: { total: 0, currency: "EUR" },
      savingsRate: { amount: 0, percentage: 0, currency: "EUR" },
      spendingHistory: [],
      incomeHistory: [],
      incomeExpense: [],
      spendingByCategory: { categories: [], total: 0 },
      sankeyData: { nodes: [], links: [] },
      upcomingPlannedExpenses: {
        currency: "EUR",
        generatedAt: new Date().toISOString().slice(0, 10),
        horizons: [
          { days: 30 as const, total: 0, items: [] },
          { days: 60 as const, total: 0, items: [] },
          { days: 90 as const, total: 0, items: [] },
        ],
      },
      periodLabel: { title: "30-Day", subtitle: "Last 30 days" },
      horizon: 30,
      referencePeriod: {
        month: monthNames[new Date().getMonth()],
        year: new Date().getFullYear(),
        label: `${monthNames[new Date().getMonth()]} ${new Date().getFullYear()}`,
      },
    };
  }

  const normalizedAccountIds = normalizeAccountIds(filters.accountIds);
  const horizonCandidate = filters.horizon ?? 30;
  const horizonDays = Number.isFinite(horizonCandidate) && horizonCandidate > 0
    ? horizonCandidate
    : 30;
  const isDateRangeMode = Boolean(filters.dateFrom);
  const latestTransactionDate = await getLatestTransactionDate(session.user.id, normalizedAccountIds);

  // Canonical window for all dashboard datasets/charts
  let startDate: Date;
  let endDate: Date;
  if (isDateRangeMode && filters.dateFrom) {
    startDate = new Date(filters.dateFrom);
    startDate.setHours(0, 0, 0, 0);
    endDate = filters.dateTo ? new Date(filters.dateTo) : new Date(latestTransactionDate);
    endDate.setHours(23, 59, 59, 999);
    if (endDate < startDate) {
      endDate = new Date(startDate);
      endDate.setHours(23, 59, 59, 999);
    }
  } else {
    endDate = new Date(latestTransactionDate);
    endDate.setHours(23, 59, 59, 999);
    startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - (horizonDays - 1));
    startDate.setHours(0, 0, 0, 0);
  }

  const incomeExpenseGrouping = resolveIncomeExpenseGrouping(startDate, endDate);

  const currency = await getUserCurrency(session.user.id);

  const [balance, balanceHistory, activity, upcomingPlannedExpenses] = await Promise.all([
    getTotalBalance(normalizedAccountIds, filters.personId),
    getBalanceHistory(startDate, endDate, normalizedAccountIds, filters.personId),
    getActivitySummary(startDate, endDate, normalizedAccountIds, filters.personId),
    getUpcomingPlannedExpenses({ days: 90, accountIds: normalizedAccountIds }),
  ]);
  const periodSpending = { total: activity.expenses, currency };
  const periodIncome = { total: activity.income, currency };
  const spendingHistory = activity.dailyData.map((day) => ({ date: day.date, value: day.expenses }));
  const incomeHistory = activity.dailyData.map((day) => ({ date: day.date, value: day.income }));
  const incomeExpense = buildIncomeExpenseBuckets({
    startDate, endDate, grouping: incomeExpenseGrouping, dailyData: activity.dailyData,
  });
  const spendingByCategory = {
    categories: activity.categories.filter((category) => category.type === "expense").slice(0, 5),
    total: activity.expenses,
  };
  const sankeyData = activitySankey(activity);

  // Calculate savings rate (income - expenses = potential savings)
  const savingsAmount = periodIncome.total - periodSpending.total;
  const cashFlow = cashFlowMetrics(activity);
  const savingsPercentage = periodIncome.total > 0
    ? (savingsAmount / periodIncome.total) * 100
    : 0;

  const isSameCalendarDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const lastDayOfMonth = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();

  const isFullMonthRange = (rangeStart: Date, rangeEnd: Date) =>
    rangeStart.getFullYear() === rangeEnd.getFullYear() &&
    rangeStart.getMonth() === rangeEnd.getMonth() &&
    rangeStart.getDate() === 1 &&
    rangeEnd.getDate() === lastDayOfMonth(rangeEnd);

  const isFullQuarterRange = (rangeStart: Date, rangeEnd: Date) => {
    const quarterStartMonth = Math.floor(rangeStart.getMonth() / 3) * 3;
    const quarterEndMonth = quarterStartMonth + 2;
    return (
      rangeStart.getFullYear() === rangeEnd.getFullYear() &&
      rangeStart.getMonth() === quarterStartMonth &&
      rangeStart.getDate() === 1 &&
      rangeEnd.getMonth() === quarterEndMonth &&
      rangeEnd.getDate() === lastDayOfMonth(rangeEnd)
    );
  };

  const isFullYearRange = (rangeStart: Date, rangeEnd: Date) =>
    rangeStart.getFullYear() === rangeEnd.getFullYear() &&
    rangeStart.getMonth() === 0 &&
    rangeStart.getDate() === 1 &&
    rangeEnd.getMonth() === 11 &&
    rangeEnd.getDate() === 31;

  const getQuarter = (date: Date) => Math.floor(date.getMonth() / 3) + 1;

  const formatShortDate = (date: Date) =>
    date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const formatShortDateNoYear = (date: Date) =>
    date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const formatLongMonthYear = (date: Date) =>
    date.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const getDateModePeriodLabel = (rangeStart: Date, rangeEnd: Date) => {
    const financialYearLabel = getAustralianFinancialYearLabelForDateRange(rangeStart, rangeEnd);
    if (financialYearLabel) {
      return { title: "Financial Year", subtitle: financialYearLabel };
    }
    if (isFullYearRange(rangeStart, rangeEnd)) {
      return { title: "Year", subtitle: String(rangeStart.getFullYear()) };
    }
    if (isFullQuarterRange(rangeStart, rangeEnd)) {
      return {
        title: "Quarter",
        subtitle: `Q${getQuarter(rangeStart)} ${rangeStart.getFullYear()}`,
      };
    }
    if (isFullMonthRange(rangeStart, rangeEnd)) {
      return { title: "Month", subtitle: formatLongMonthYear(rangeStart) };
    }
    if (isSameCalendarDay(rangeStart, rangeEnd)) {
      return { title: "Day", subtitle: formatShortDate(rangeStart) };
    }
    if (rangeStart.getFullYear() === rangeEnd.getFullYear()) {
      if (rangeStart.getMonth() === rangeEnd.getMonth()) {
        return {
          title: "Custom",
          subtitle: `${rangeStart.toLocaleDateString("en-US", {
            month: "short",
          })} ${rangeStart.getDate()} - ${rangeEnd.getDate()}, ${rangeStart.getFullYear()}`,
        };
      }
      return {
        title: "Custom",
        subtitle: `${formatShortDateNoYear(rangeStart)} - ${formatShortDateNoYear(rangeEnd)}, ${rangeStart.getFullYear()}`,
      };
    }
    return {
      title: "Custom",
      subtitle: `${formatShortDate(rangeStart)} - ${formatShortDate(rangeEnd)}`,
    };
  };

  // Generate period label based on horizon
  const getHorizonPeriodLabel = (h: number) => {
    if (h <= 7) return { title: "7-Day", subtitle: "Last 7 days" };
    if (h <= 30) return { title: "30-Day", subtitle: "Last 30 days" };
    return { title: "12-Month", subtitle: "Last 12 months" };
  };

  const periodLabel = isDateRangeMode
    ? getDateModePeriodLabel(startDate, endDate)
    : getHorizonPeriodLabel(horizonDays);

  return {
    cashFlow,
    activityMissingConversions: activity.missingConversions,
    balance,
    balanceHistory,
    periodSpending,
    periodIncome,
    savingsRate: {
      amount: savingsAmount,
      percentage: savingsPercentage,
      currency,
    },
    spendingHistory,
    incomeHistory,
    incomeExpense,
    spendingByCategory,
    sankeyData,
    upcomingPlannedExpenses,
    periodLabel,
    horizon: horizonDays,
    referencePeriod: {
      month: monthNames[endDate.getMonth()],
      year: endDate.getFullYear(),
      label: `${monthNames[endDate.getMonth()]} ${endDate.getFullYear()}`,
    },
  };
}

export async function getCashFlowSummary(startDate: Date, endDate: Date, accountIds?: string[], personId?: string) {
  return cashFlowMetrics(await getActivitySummary(startDate, endDate, accountIds, personId));
}
