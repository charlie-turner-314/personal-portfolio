"use server";
import { endOfDay,endOfMonth,startOfDay,startOfMonth,subDays } from "date-fns";
import { and,eq,inArray,sql } from "drizzle-orm";
import { getAuthenticatedSession } from "@/lib/household/financial-auth";
import { accountAccess } from "@/lib/household/account-access";
import { db } from "@/lib/db";
import { transactions,users } from "@/lib/db/schema";
import { fetchFinancialActivity } from "@/lib/reporting/activity-query";
import { getTransactionsForExport,type TransactionWithRelations } from "@/lib/actions/transactions";
import type { SupportedHorizon } from "@/lib/dashboard/query-params";
import type { CategorySpendingSortField,CategorySpendingSortOrder } from "@/lib/category-spending/query-params";
import { computePreviousWindow,formatIsoDate,getTouchedMonthKeys,parseIsoDateAtEndOfDay,parseIsoDateAtStartOfDay,resolveCategoryColor } from "@/lib/category-spending/helpers";

export interface CategorySpendingFilters {
  personId?:string;
  accountIds?: string[];
  dateFrom?: string;
  dateTo?: string;
  horizon?: SupportedHorizon;
}

export interface CategorySpendingTransactionsFilters extends CategorySpendingFilters {
  categoryIds?: string[];
  page?: number;
  pageSize?: number;
  sort?: CategorySpendingSortField;
  order?: CategorySpendingSortOrder;
}

export interface CategorySpendingCategory {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  fill: string;
  amount: number;
  sharePct: number;
  deltaAmount: number;
  deltaPct: number;
  averageMonthlyAmount: number;
}

export interface CategorySpendingSummary {
  totalSpend: number;
  averageMonthlySpend: number;
  topCategory: {
    id: string;
    name: string;
    amount: number;
  } | null;
}

export interface CategorySpendingData {
  missingConversions?:number;
  currency: string;
  categories: CategorySpendingCategory[];
  summary: CategorySpendingSummary;
  range: {
    startDate: string;
    endDate: string;
    comparisonStartDate: string;
    comparisonEndDate: string;
    monthCount: number;
    referenceDate: string;
  };
}

export interface CategorySpendingTransactionsPageResult {
  rows: TransactionWithRelations[];
  totalCount: number;
  page: number;
  pageSize: number;
}

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MIN_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

function normalizeAccountIds(accountIds?: string[]): string[] {
  if (!accountIds?.length) {
    return [];
  }

  return Array.from(new Set(accountIds.map((id) => id.trim()).filter(Boolean)));
}

function normalizeCategoryIds(categoryIds?: string[]): string[] {
  if (!categoryIds?.length) {
    return [];
  }

  return Array.from(new Set(categoryIds.map((id) => id.trim()).filter(Boolean)));
}

function normalizePage(value?: number): number {
  if (!value || !Number.isFinite(value)) {
    return DEFAULT_PAGE;
  }
  return Math.max(DEFAULT_PAGE, Math.floor(value));
}

function normalizePageSize(value?: number): number {
  if (!value || !Number.isFinite(value)) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.max(MIN_PAGE_SIZE, Math.min(MAX_PAGE_SIZE, Math.floor(value)));
}

async function getUserCurrency(userId: string): Promise<string> {
  const result = await db
    .select({ functionalCurrency: users.functionalCurrency })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return result[0]?.functionalCurrency || "EUR";
}

async function getLatestTransactionDate(
  userId: string,
  accountIds: string[]
): Promise<Date> {
  const conditions = [accountAccess(transactions.accountId, userId)];
  if (accountIds.length > 0) {
    conditions.push(inArray(transactions.accountId, accountIds));
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

function resolvePrimaryRange(
  filters: CategorySpendingFilters,
  referenceDate: Date
): {
  startDate: Date;
  endDate: Date;
} {
  if (filters.dateFrom) {
    const startDate = parseIsoDateAtStartOfDay(filters.dateFrom);
    const endDate = filters.dateTo
      ? parseIsoDateAtEndOfDay(filters.dateTo)
      : endOfDay(referenceDate);

    if (endDate < startDate) {
      return {
        startDate,
        endDate: endOfDay(startDate),
      };
    }

    return {
      startDate,
      endDate,
    };
  }

  if (filters.horizon) {
    const endDate = endOfDay(referenceDate);
    return {
      startDate: startOfDay(subDays(endDate, filters.horizon - 1)),
      endDate,
    };
  }

  return {
    startDate: startOfMonth(referenceDate),
    endDate: endOfMonth(referenceDate),
  };
}

export async function getCategorySpendingData(
  filters: CategorySpendingFilters = {}
): Promise<CategorySpendingData> {
  const session = await getAuthenticatedSession();

  if (!session?.user?.id) {
    return {
      currency: "EUR",
      categories: [],
      summary: {
        totalSpend: 0,
        averageMonthlySpend: 0,
        topCategory: null,
      },
      range: {
        startDate: formatIsoDate(new Date()),
        endDate: formatIsoDate(new Date()),
        comparisonStartDate: formatIsoDate(new Date()),
        comparisonEndDate: formatIsoDate(new Date()),
        monthCount: 1,
        referenceDate: formatIsoDate(new Date()),
      },
    };
  }

  const normalizedAccountIds = normalizeAccountIds(filters.accountIds);
  const [currency, referenceDate] = await Promise.all([
    getUserCurrency(session.user.id),
    getLatestTransactionDate(session.user.id, normalizedAccountIds),
  ]);

  const { startDate, endDate } = resolvePrimaryRange(filters, referenceDate);
  const { comparisonStart, comparisonEnd } = computePreviousWindow(startDate, endDate);

  const [current,previous]=await Promise.all([
    fetchFinancialActivity(session.user.id,{startDate,endDate,accountIds:normalizedAccountIds,personId:filters.personId}),
    fetchFinancialActivity(session.user.id,{startDate:comparisonStart,endDate:comparisonEnd,accountIds:normalizedAccountIds,personId:filters.personId}),
  ]);
  const currentCategories=current.categories.filter(category=>category.type==="expense");
  const previousCategories=previous.categories.filter(category=>category.type==="expense");
  const previousById=new Map(previousCategories.map(item=>[item.id,item.amount]));
  const totalSpend = currentCategories.reduce((sum, item) => sum + item.amount, 0);
  const monthCount = Math.max(1, getTouchedMonthKeys(startDate, endDate).length);

  const categoriesWithMetrics: CategorySpendingCategory[] = currentCategories.map((item, index) => {
    const previousAmount = previousById.get(item.id) ?? 0;
    const deltaAmount = item.amount - previousAmount;
    const deltaPct =
      previousAmount > 0
        ? (deltaAmount / previousAmount) * 100
        : item.amount > 0
          ? 100
          : 0;

    return {
      id: item.id,
      name: item.name,
      color: item.color,
      icon: item.icon,
      fill: resolveCategoryColor(item.color, index),
      amount: item.amount,
      sharePct: totalSpend > 0 ? (item.amount / totalSpend) * 100 : 0,
      deltaAmount,
      deltaPct,
      averageMonthlyAmount: item.amount / monthCount,
    };
  });

  const topCategory = categoriesWithMetrics[0]
    ? {
        id: categoriesWithMetrics[0].id,
        name: categoriesWithMetrics[0].name,
        amount: categoriesWithMetrics[0].amount,
      }
    : null;

  return {
    currency,
    missingConversions:current.missingConversions+previous.missingConversions,
    categories: categoriesWithMetrics,
    summary: {
      totalSpend,
      averageMonthlySpend: totalSpend / monthCount,
      topCategory,
    },
    range: {
      startDate: formatIsoDate(startDate),
      endDate: formatIsoDate(endDate),
      comparisonStartDate: formatIsoDate(comparisonStart),
      comparisonEndDate: formatIsoDate(comparisonEnd),
      monthCount,
      referenceDate: formatIsoDate(referenceDate),
    },
  };
}

/** Drilldown is the same consumption entries used by the category chart,
 * including refunds and linked netting. Full bank values remain available in details. */
export async function getCategorySpendingTransactionsPage(filters:CategorySpendingTransactionsFilters={}):Promise<CategorySpendingTransactionsPageResult> {
  const session=await getAuthenticatedSession();
  const page=normalizePage(filters.page),pageSize=normalizePageSize(filters.pageSize);
  if(!session?.user?.id)return {rows:[],totalCount:0,page,pageSize};
  const accountIds=normalizeAccountIds(filters.accountIds);
  const reference=await getLatestTransactionDate(session.user.id,accountIds);
  const {startDate,endDate}=resolvePrimaryRange(filters,reference);
  const activity=await fetchFinancialActivity(session.user.id,{startDate,endDate,accountIds,personId:filters.personId});
  const selected=normalizeCategoryIds(filters.categoryIds);
  const grouped=new Map<string,{id:string;amount:number;date:string;description:string;merchant:string}>();
  for(const entry of activity.entries) {
    if(entry.kind!=="consumption"||!entry.transactionId||(selected.length&&!selected.includes(entry.categoryId)))continue;
    const row=grouped.get(entry.transactionId)??{id:entry.transactionId,amount:0,date:entry.date,description:entry.description??"",merchant:entry.merchant??""};
    row.amount-=entry.amount;grouped.set(row.id,row);
  }
  const sort=filters.sort??"bookedAt",direction=filters.order==="asc"?1:-1;
  const entries=[...grouped.values()].sort((left,right)=>{
    const compared=sort==="amount"?left.amount-right.amount:sort==="description"?left.description.localeCompare(right.description):sort==="merchant"?left.merchant.localeCompare(right.merchant):left.date.localeCompare(right.date);
    return compared*direction||left.id.localeCompare(right.id);
  });
  const included=entries.slice((page-1)*pageSize,page*pageSize);
  if(!included.length)return {rows:[],totalCount:entries.length,page,pageSize};
  const fresh=await getTransactionsForExport(included.map(row=>row.id),filters.personId);
  const byId=new Map(fresh.map(row=>[row.id,row]));
  return {rows:included.flatMap(entry=>{const row=byId.get(entry.id);return row?[{...row,attributedAmount:entry.amount}]:[];}),totalCount:entries.length,page,pageSize};
}
