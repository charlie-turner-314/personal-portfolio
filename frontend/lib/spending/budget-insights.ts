import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { db } from "@/lib/db";
import {
  categories,
  recurringTransactions,
  transactions,
  transactionLinks,
} from "@/lib/db/schema";
import {
  buildLinkedExpenseAmountSql,
  fetchCategoryActualAmounts,
} from "@/lib/spending/category-actuals";

export type BudgetVarianceDriver = "one_off" | "recurring" | "mixed";

export interface BudgetInsightCategoryInput {
  categoryId: string;
  categoryName: string;
  plannedAmount: number;
  actualAmount: number;
  overspendAmount: number;
}

export interface BudgetMerchantContributor {
  name: string;
  amount: number;
  transactionCount: number;
}

export interface BudgetTransactionContributor {
  id: string;
  description: string | null;
  merchant: string | null;
  bookedAt: string;
  amount: number;
  recurringName: string | null;
}

export interface BudgetCategoryInsight {
  categoryId: string;
  categoryName: string;
  plannedAmount: number;
  actualAmount: number;
  overspendAmount: number;
  previousMonthAmount: number | null;
  previousThreeMonthAverage: number | null;
  sameMonthLastYearAmount: number | null;
  driverType: BudgetVarianceDriver;
  explanation: string;
  topMerchants: BudgetMerchantContributor[];
  topTransactions: BudgetTransactionContributor[];
}

interface FetchBudgetInsightsOptions {
  monthKey: string;
  startDate: Date;
  endDate: Date;
  accountIds?: string[];
  categories: BudgetInsightCategoryInput[];
}

interface DateWindow {
  startDate: Date;
  endDate: Date;
}

interface MerchantRow {
  categoryId: string;
  name: string | null;
  amount: string | number | null;
  transactionCount: number | string | null;
}

interface TransactionRow {
  id: string;
  categoryId: string;
  description: string | null;
  merchant: string | null;
  bookedAt: Date;
  amount: string | number | null;
  recurringTransactionId: string | null;
  recurringName: string | null;
}

interface DriverTransaction {
  amount: number;
  isRecurring: boolean;
}

interface TransactionContributorResult {
  topTransactionsByCategory: Map<string, BudgetTransactionContributor[]>;
  driverTransactionsByCategory: Map<string, DriverTransaction[]>;
}

function parseMoney(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function normalizeAccountIds(accountIds?: string[]): string[] {
  if (!accountIds?.length) {
    return [];
  }

  return Array.from(new Set(accountIds.map((id) => id.trim()).filter(Boolean)));
}

function monthWindow(year: number, monthIndex: number): DateWindow {
  return {
    startDate: new Date(year, monthIndex, 1),
    endDate: new Date(year, monthIndex + 1, 0, 23, 59, 59, 999),
  };
}

function previousMonthWindows(monthKey: string, count: number): DateWindow[] {
  const year = Number(monthKey.slice(0, 4));
  const monthIndex = Number(monthKey.slice(5, 7)) - 1;

  return Array.from({ length: count }, (_, index) =>
    monthWindow(year, monthIndex - index - 1)
  );
}

function sameMonthLastYearWindow(monthKey: string): DateWindow {
  const year = Number(monthKey.slice(0, 4)) - 1;
  const monthIndex = Number(monthKey.slice(5, 7)) - 1;
  return monthWindow(year, monthIndex);
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return parseMoney(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function groupAmountsByCategory(
  rows: { id: string; amount: number }[]
): Map<string, number> {
  return new Map(rows.map((row) => [row.id, parseMoney(row.amount)]));
}

export function buildBudgetInsightExplanation({
  categoryName,
  overspendAmount,
  plannedAmount,
  actualAmount,
  previousThreeMonthAverage,
  sameMonthLastYearAmount,
  driverType,
  topMerchants,
}: Pick<
  BudgetCategoryInsight,
  | "categoryName"
  | "overspendAmount"
  | "plannedAmount"
  | "actualAmount"
  | "previousThreeMonthAverage"
  | "sameMonthLastYearAmount"
  | "driverType"
  | "topMerchants"
>): string {
  const leadingMerchant = topMerchants[0]?.name;
  const budgetPhrase = `${categoryName} is ${Math.round((actualAmount / Math.max(plannedAmount, 1)) * 100)}% of plan`;
  const driverPhrase =
    driverType === "one_off"
      ? "mostly from one-off spending"
      : driverType === "recurring"
        ? "mostly from recurring spend"
        : "from a mix of one-off and recurring spend";
  const merchantPhrase = leadingMerchant ? ` led by ${leadingMerchant}` : "";
  const comparisonParts = [];

  if (previousThreeMonthAverage !== null) {
    const diff = parseMoney(actualAmount - previousThreeMonthAverage);
    if (Math.abs(diff) >= Math.max(25, overspendAmount * 0.25)) {
      comparisonParts.push(
        `${diff > 0 ? "above" : "below"} the prior 3-month average`
      );
    }
  }

  if (sameMonthLastYearAmount !== null && sameMonthLastYearAmount > 0) {
    const diff = parseMoney(actualAmount - sameMonthLastYearAmount);
    if (Math.abs(diff) >= Math.max(25, overspendAmount * 0.25)) {
      comparisonParts.push(`${diff > 0 ? "above" : "below"} the same month last year`);
    }
  }

  const comparisonPhrase =
    comparisonParts.length > 0 ? ` and is ${comparisonParts.join(" and ")}` : "";

  return `${budgetPhrase}, over by ${overspendAmount.toFixed(0)}, ${driverPhrase}${merchantPhrase}${comparisonPhrase}.`;
}

export function resolveBudgetVarianceDriver(
  overspendAmount: number,
  transactionsForCategory: DriverTransaction[]
): BudgetVarianceDriver {
  const recurringAmount = transactionsForCategory
    .filter((transaction) => transaction.isRecurring)
    .reduce((sum, transaction) => sum + transaction.amount, 0);
  const oneOffTransactions = transactionsForCategory.filter(
    (transaction) => !transaction.isRecurring
  );
  const oneOffAmount = oneOffTransactions.reduce(
    (sum, transaction) => sum + transaction.amount,
    0
  );
  const largestOneOff = oneOffTransactions
    .reduce((max, transaction) => Math.max(max, transaction.amount), 0);
  const totalAmount = recurringAmount + oneOffAmount;

  if (totalAmount <= 0) {
    return "mixed";
  }

  if (recurringAmount >= Math.max(overspendAmount * 0.6, totalAmount * 0.6, 50)) {
    return "recurring";
  }

  if (
    largestOneOff >= Math.max(overspendAmount * 0.6, totalAmount * 0.35, 50)
  ) {
    return "one_off";
  }

  return "mixed";
}

function buildBaseConditions(
  userId: string,
  categoryIds: string[],
  startDate: Date,
  endDate: Date,
  accountIds: string[]
): SQLWrapper[] {
  const conditions: SQLWrapper[] = [
    eq(transactions.userId, userId),
    eq(transactions.transactionType, "debit"),
    eq(transactions.includeInAnalytics, true),
    isNull(transactions.internalTransferId),
    eq(categories.userId, userId),
    eq(categories.categoryType, "expense"),
    inArray(categories.id, categoryIds),
    gte(transactions.bookedAt, startDate),
    lte(transactions.bookedAt, endDate),
    or(isNull(transactionLinks.linkRole), eq(transactionLinks.linkRole, "primary"))!,
  ];

  if (accountIds.length > 0) {
    conditions.push(inArray(transactions.accountId, accountIds));
  }

  return conditions;
}

async function fetchTopMerchants(
  userId: string,
  categoryIds: string[],
  startDate: Date,
  endDate: Date,
  accountIds: string[]
): Promise<Map<string, BudgetMerchantContributor[]>> {
  if (categoryIds.length === 0) {
    return new Map();
  }

  const merchantNameSql = sql<string>`COALESCE(NULLIF(${transactions.merchant}, ''), NULLIF(${transactions.creditor}, ''), NULLIF(${transactions.description}, ''), 'Unknown merchant')`;
  const linkedMerchantAmountSql = buildLinkedExpenseAmountSql({
    userId,
    startDate,
    endDate,
    accountIds,
  });
  const rows = await db
    .select({
      categoryId: categories.id,
      name: merchantNameSql,
      amount: linkedMerchantAmountSql,
      transactionCount: sql<number>`COUNT(*)::int`,
    })
    .from(transactions)
    .innerJoin(
      categories,
      sql`${categories.id} = COALESCE(${transactions.categoryId}, ${transactions.categorySystemId})`
    )
    .leftJoin(transactionLinks, eq(transactions.id, transactionLinks.transactionId))
    .where(and(...buildBaseConditions(userId, categoryIds, startDate, endDate, accountIds)))
    .groupBy(categories.id, merchantNameSql)
    .orderBy(desc(linkedMerchantAmountSql)) as MerchantRow[];

  const byCategory = new Map<string, BudgetMerchantContributor[]>();
  for (const row of rows) {
    const amount = parseMoney(row.amount);
    if (amount <= 0) {
      continue;
    }

    const list = byCategory.get(row.categoryId) ?? [];
    if (list.length < 3) {
      list.push({
        name: row.name ?? "Unknown merchant",
        amount,
        transactionCount: Number(row.transactionCount ?? 0),
      });
      byCategory.set(row.categoryId, list);
    }
  }

  return byCategory;
}

async function fetchTransactionContributors(
  userId: string,
  categoryIds: string[],
  startDate: Date,
  endDate: Date,
  accountIds: string[]
): Promise<TransactionContributorResult> {
  if (categoryIds.length === 0) {
    return {
      topTransactionsByCategory: new Map(),
      driverTransactionsByCategory: new Map(),
    };
  }

  const linkedTransactionAmountSql = buildLinkedExpenseAmountSql({
    userId,
    startDate,
    endDate,
    accountIds,
    aggregate: false,
  });
  const rows = await db
    .select({
      id: transactions.id,
      categoryId: categories.id,
      description: transactions.description,
      merchant: transactions.merchant,
      bookedAt: transactions.bookedAt,
      amount: linkedTransactionAmountSql,
      recurringTransactionId: transactions.recurringTransactionId,
      recurringName: recurringTransactions.name,
    })
    .from(transactions)
    .innerJoin(
      categories,
      sql`${categories.id} = COALESCE(${transactions.categoryId}, ${transactions.categorySystemId})`
    )
    .leftJoin(transactionLinks, eq(transactions.id, transactionLinks.transactionId))
    .leftJoin(
      recurringTransactions,
      eq(transactions.recurringTransactionId, recurringTransactions.id)
    )
    .where(and(...buildBaseConditions(userId, categoryIds, startDate, endDate, accountIds)))
    .orderBy(desc(linkedTransactionAmountSql)) as TransactionRow[];

  const topTransactionsByCategory = new Map<string, BudgetTransactionContributor[]>();
  const driverTransactionsByCategory = new Map<string, DriverTransaction[]>();
  for (const row of rows) {
    const amount = parseMoney(row.amount);
    if (amount <= 0) {
      continue;
    }

    const contributor = {
      id: row.id,
      description: row.description,
      merchant: row.merchant,
      bookedAt: row.bookedAt.toISOString().slice(0, 10),
      amount,
      recurringName: row.recurringName,
    };

    const driverTransactions = driverTransactionsByCategory.get(row.categoryId) ?? [];
    driverTransactions.push({
      amount,
      isRecurring: row.recurringTransactionId !== null,
    });
    driverTransactionsByCategory.set(row.categoryId, driverTransactions);

    const topTransactions = topTransactionsByCategory.get(row.categoryId) ?? [];
    if (topTransactions.length < 3) {
      topTransactions.push(contributor);
      topTransactionsByCategory.set(row.categoryId, topTransactions);
    }
  }

  return { topTransactionsByCategory, driverTransactionsByCategory };
}

export async function fetchBudgetInsights(
  userId: string,
  {
    monthKey,
    startDate,
    endDate,
    accountIds,
    categories: overBudgetCategories,
  }: FetchBudgetInsightsOptions
): Promise<BudgetCategoryInsight[]> {
  if (overBudgetCategories.length === 0) {
    return [];
  }

  const normalizedAccountIds = normalizeAccountIds(accountIds);
  const categoryIds = overBudgetCategories.map((category) => category.categoryId);
  const previousWindows = previousMonthWindows(monthKey, 3);
  const sameMonthLastYear = sameMonthLastYearWindow(monthKey);

  const [previousRows, sameMonthLastYearRows, topMerchants, transactionContributors] =
    await Promise.all([
      Promise.all(
        previousWindows.map((window) =>
          fetchCategoryActualAmounts(userId, {
            ...window,
            accountIds: normalizedAccountIds,
            includeUncategorized: false,
          })
        )
      ),
      fetchCategoryActualAmounts(userId, {
        ...sameMonthLastYear,
        accountIds: normalizedAccountIds,
        includeUncategorized: false,
      }),
      fetchTopMerchants(userId, categoryIds, startDate, endDate, normalizedAccountIds),
      fetchTransactionContributors(
        userId,
        categoryIds,
        startDate,
        endDate,
        normalizedAccountIds
      ),
    ]);

  const previousByCategory = previousRows.map(groupAmountsByCategory);
  const sameMonthLastYearByCategory = groupAmountsByCategory(sameMonthLastYearRows);

  return overBudgetCategories.map((category) => {
    const previousAmounts = previousByCategory.flatMap((rows) => {
      const amount = rows.get(category.categoryId);
      return amount === undefined ? [] : [amount];
    });
    const previousMonthAmount = previousByCategory[0]?.get(category.categoryId) ?? null;
    const merchantContributors = topMerchants.get(category.categoryId) ?? [];
    const topTransactions =
      transactionContributors.topTransactionsByCategory.get(category.categoryId) ?? [];
    const sameMonthLastYearAmount =
      sameMonthLastYearByCategory.get(category.categoryId) ?? null;
    const previousThreeMonthAverage = average(previousAmounts);
    const driverType = resolveBudgetVarianceDriver(
      category.overspendAmount,
      transactionContributors.driverTransactionsByCategory.get(category.categoryId) ?? []
    );

    return {
      categoryId: category.categoryId,
      categoryName: category.categoryName,
      plannedAmount: category.plannedAmount,
      actualAmount: category.actualAmount,
      overspendAmount: category.overspendAmount,
      previousMonthAmount,
      previousThreeMonthAverage,
      sameMonthLastYearAmount,
      driverType,
      explanation: buildBudgetInsightExplanation({
        categoryName: category.categoryName,
        plannedAmount: category.plannedAmount,
        actualAmount: category.actualAmount,
        overspendAmount: category.overspendAmount,
        previousThreeMonthAverage,
        sameMonthLastYearAmount,
        driverType,
        topMerchants: merchantContributors,
      }),
      topMerchants: merchantContributors,
      topTransactions,
    };
  });
}
