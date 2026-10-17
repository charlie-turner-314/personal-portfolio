"use server";

import { db } from "@/lib/db";
import { accounts, transactions, categories, users, properties, vehicles, accountBalances, accountOwnershipAllocations, transactionLinks, propertyLiabilityLinks, superAccounts } from "@/lib/db/schema";
import { getAuthenticatedSession } from "@/lib/auth-helpers";
import { getCachedUserAccounts } from "@/lib/data/cached";
import { eq, sql, gte, lte, and, desc, inArray, isNull, type SQL, type SQLWrapper } from "drizzle-orm";
import { summarizeActivity, activitySankey } from "@/lib/dashboard/activity";
import {
  buildIncomeExpenseBuckets,
  resolveIncomeExpenseGrouping,
  type IncomeExpenseGrouping,
} from "@/lib/dashboard/income-expense-buckets";
import { getPortfolio } from "@/lib/api/investments";
import { getUpcomingPlannedExpenses } from "@/lib/actions/planned-expenses";
import {
  calculateNetWorthOverview,
  emptyNetWorthOverview,
  type NetWorthEntry,
  type NetWorthOverview,
} from "@/lib/net-worth/calculation";
import {
  calculatePropertyEquity,
  getLinkedLiabilityAccountIds,
} from "@/lib/properties/equity";
import { getAustralianFinancialYearLabelForDateRange } from "@/lib/dates/australian-financial-year";
import { getHistoricalSnapshotHistory } from "@/lib/actions/historical-snapshots";

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

function ownershipShareSql(
  personId: string | undefined,
  accountId: SQLWrapper,
  bookedAt: SQLWrapper,
): SQL<unknown> {
  if (!personId) return sql`1`;

  return sql`COALESCE((
    SELECT aoa.share
    FROM ${accountOwnershipAllocations} aoa
    WHERE aoa.account_id = ${accountId}
      AND aoa.person_id = ${personId}
      AND aoa.effective_from <= (${bookedAt})::date
    ORDER BY aoa.effective_from DESC
    LIMIT 1
  ), 0)`;
}

const t2AccountId = sql.raw("t2.account_id");
const t2BookedAt = sql.raw("t2.booked_at");

async function getLatestTransactionDate(userId: string, accountIds?: string[]): Promise<Date> {
  const normalizedAccountIds = normalizeAccountIds(accountIds);
  const conditions = [eq(transactions.userId, userId)];
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
    .where(eq(transactions.userId, session.user.id))
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

export async function getTotalBalance(accountIds?: string[], personId?: string) {
  const session = await getAuthenticatedSession();

  if (!session?.user?.id) {
    return { total: 0, currency: "EUR" };
  }

  // Get user's active account IDs
  const accountConditions = [
    eq(accounts.userId, session.user.id),
    eq(accounts.isActive, true),
  ];
  const normalizedAccountIds = normalizeAccountIds(accountIds);
  if (normalizedAccountIds?.length) {
    accountConditions.push(inArray(accounts.id, normalizedAccountIds));
  }

  const userAccounts = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(...accountConditions));

  if (userAccounts.length === 0) {
    const currency = await getUserCurrency(session.user.id);
    return { total: 0, currency };
  }

  const selectedAccountIds = userAccounts.map((a) => a.id);

  // Get the latest balance for EACH account, then sum them
  // This ensures accounts with different latest dates are all included
  const [result, currency] = await Promise.all([
    db
      .select({
        total: personId
          ? sql<string>`COALESCE(SUM(ab.balance_in_functional_currency * COALESCE((
              SELECT aoa.share FROM ${accountOwnershipAllocations} aoa
              WHERE aoa.account_id = ab.account_id AND aoa.person_id = ${personId}
                AND aoa.effective_from <= ab.date::date
              ORDER BY aoa.effective_from DESC LIMIT 1
            ), 0)), 0)`
          : sql<string>`COALESCE(SUM(ab.balance_in_functional_currency), 0)`,
      })
      .from(sql`(
        SELECT DISTINCT ON (account_id) account_id, balance_in_functional_currency, date
        FROM account_balances
        WHERE account_id IN (${sql.join(selectedAccountIds.map((id) => sql`${id}`), sql`, `)})
        ORDER BY account_id, date DESC
      ) AS ab`),
    getUserCurrency(session.user.id),
  ]);

  return {
    total: parseFloat(result[0]?.total || "0"),
    currency,
  };
}

export async function getBalanceHistory(startDate: Date, endDate: Date, accountIds?: string[], personId?: string) {
  const session = await getAuthenticatedSession();

  if (!session?.user?.id) {
    return [];
  }

  const normalizedAccountIds = normalizeAccountIds(accountIds);

  // Get user's active account IDs
  const accountConditions = [
    eq(accounts.userId, session.user.id),
    eq(accounts.isActive, true),
  ];
  if (normalizedAccountIds?.length) {
    accountConditions.push(inArray(accounts.id, normalizedAccountIds));
  }

  const userAccounts = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(...accountConditions));

  if (userAccounts.length === 0) {
    return normalizedAccountIds?.length || personId ? [] : getHistoricalSnapshotHistory(startDate, endDate);
  }

  const selectedAccountIds = userAccounts.map((a) => a.id);

  // Query account_balances table - sum across accounts per day
  const result = await db
    .select({
      date: sql<string>`DATE(${accountBalances.date})`,
      value: personId
        ? sql<string>`SUM(${accountBalances.balanceInFunctionalCurrency} * COALESCE((
            SELECT aoa.share FROM ${accountOwnershipAllocations} aoa
            WHERE aoa.account_id = ${accountBalances.accountId} AND aoa.person_id = ${personId}
              AND aoa.effective_from <= ${accountBalances.date}::date
            ORDER BY aoa.effective_from DESC LIMIT 1
          ), 0))`
        : sql<string>`SUM(${accountBalances.balanceInFunctionalCurrency})`,
    })
    .from(accountBalances)
    .where(and(
      inArray(accountBalances.accountId, selectedAccountIds),
      gte(accountBalances.date, startDate),
      lte(accountBalances.date, endDate)
    ))
    .groupBy(sql`DATE(${accountBalances.date})`)
    .orderBy(sql`DATE(${accountBalances.date})`);

  const calculated = result.map(row => ({
    date: row.date,
    value: parseFloat(row.value || "0"),
  }));
  // Imported snapshots are complete reported net-worth points. Prefer them for
  // matching dates so partial account balances cannot double-count assets.
  // Imported snapshots describe the whole household and cannot be split
  // retrospectively without account-level data.
  if (normalizedAccountIds?.length || personId) return calculated;
  const imported = await getHistoricalSnapshotHistory(startDate, endDate);
  const byDate = new Map(calculated.map((point) => [point.date.slice(0, 10), point]));
  for (const point of imported) byDate.set(point.date, point);
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// All activity widgets share classification and linked-transaction semantics.
// A LEFT JOIN is essential: categorization enriches activity, never gates it.
async function getActivitySummary(startDate: Date, endDate: Date, accountIds?: string[], personId?: string) {
  const session = await getAuthenticatedSession();
  if (!session?.user?.id) return summarizeActivity([]);
  const normalizedAccountIds = normalizeAccountIds(accountIds);
  const conditions = [
    eq(transactions.userId, session.user.id),
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
    categoryId: categories.id,
    categoryName: categories.name,
    categoryType: categories.categoryType,
    icon: categories.icon,
    color: categories.color,
    amount: sql<string | null>`CASE
      WHEN ${transactionLinks.linkRole} = 'primary' AND ${transactionLinks.groupId} IS NOT NULL THEN
        (
          SELECT CASE WHEN COUNT(*) FILTER (WHERE ${linkedAmountInCurrency} IS NULL) > 0 THEN NULL
            ELSE SUM(${linkedAmountInCurrency} * ${ownershipShareSql(personId, t2AccountId, t2BookedAt)}) END
          FROM ${transactions} t2
          JOIN ${transactionLinks} tl2 ON t2.id = tl2.transaction_id
          WHERE tl2.group_id = ${transactionLinks.groupId}
            AND t2.user_id = ${session.user.id}
            AND t2.include_in_analytics = true
            AND t2.internal_transfer_id IS NULL
        )
      WHEN ${transactionLinks.linkRole} IS NOT NULL THEN 0
      ELSE ${amountInCurrency} * ${ownershipShareSql(personId, transactions.accountId, transactions.bookedAt)}
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

export async function getAssetsOverview(): Promise<NetWorthOverview> {
  const session = await getAuthenticatedSession();

  if (!session?.user?.id) {
    return emptyNetWorthOverview();
  }

  const [userAccounts, userProperties, userVehicles, userPropertyLiabilityLinks, currency, portfolio] = await Promise.all([
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
      })
      .from(accounts)
      .leftJoin(
        superAccounts,
        and(
          eq(superAccounts.accountId, accounts.id),
          eq(superAccounts.userId, session.user.id),
        ),
      )
      .where(and(eq(accounts.userId, session.user.id), eq(accounts.isActive, true))),
    db
      .select({
        id: properties.id,
        name: properties.name,
        propertyType: properties.propertyType,
        address: properties.address,
        currentValue: properties.currentValue,
        currency: properties.currency,
      })
      .from(properties)
      .where(and(eq(properties.userId, session.user.id), eq(properties.isActive, true))),
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
    db
      .select({
        propertyId: propertyLiabilityLinks.propertyId,
        accountId: propertyLiabilityLinks.accountId,
      })
      .from(propertyLiabilityLinks)
      .where(eq(propertyLiabilityLinks.userId, session.user.id)),
    getUserCurrency(session.user.id),
    getPortfolio().catch(() => null),
  ]);

  const linkedLiabilityAccountIds = getLinkedLiabilityAccountIds(userPropertyLiabilityLinks);
  const entries: NetWorthEntry[] = [
    ...userAccounts
      .filter((account) => !linkedLiabilityAccountIds.has(account.id))
      .map((account) => ({
        id: account.id,
        name: account.name,
        institution: account.institution,
        value: account.functionalBalance,
        currency: account.currency || currency,
        source: "account" as const,
        accountType: account.accountType,
        isSuperannuation: account.superAccountId !== null,
        includeInNetWorth: account.includeSuperInNetWorth,
      })),
    ...userProperties.map((property) => {
      const addressParts = property.address?.split(",").map((part) => part.trim()) || [];
      const location = addressParts.length > 1 ? addressParts.slice(-2).join(", ") : property.address;
      const equity = calculatePropertyEquity(
        property,
        userAccounts,
        userPropertyLiabilityLinks,
      );

      return {
        id: property.id,
        name: property.name,
        institution: location || null,
        value: equity.equity,
        currency: property.currency || currency,
        source: "property" as const,
      };
    }),
    ...userVehicles.map((vehicle) => ({
      id: vehicle.id,
      name: vehicle.name,
      institution: [vehicle.make, vehicle.model].filter(Boolean).join(" ") || null,
      value: vehicle.currentValue,
      currency: vehicle.currency || currency,
      source: "vehicle" as const,
    })),
    ...(portfolio?.accounts || []).map((account) => ({
      id: account.id,
      name: account.name,
      institution: account.type || null,
      value: account.value,
      currency: portfolio?.currency || currency,
      source: "portfolio" as const,
    })),
  ];

  return calculateNetWorthOverview(entries, currency);
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
      assetsOverview: emptyNetWorthOverview(),
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

  const [balance, balanceHistory, activity, assetsOverview, upcomingPlannedExpenses] = await Promise.all([
    getTotalBalance(normalizedAccountIds, filters.personId),
    getBalanceHistory(startDate, endDate, normalizedAccountIds, filters.personId),
    getActivitySummary(startDate, endDate, normalizedAccountIds, filters.personId),
    getAssetsOverview(),
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
    assetsOverview,
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
