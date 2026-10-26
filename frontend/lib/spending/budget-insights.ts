import { fetchFinancialActivity } from "@/lib/reporting/activity-query";
import { fetchCategoryActualAmounts, type CategoryActualAmount } from "./category-actuals";

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
  personId?:string;
}

interface DateWindow {
  startDate: Date;
  endDate: Date;
}

interface DriverTransaction {
  amount: number;
  isRecurring: boolean;
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
  rows: CategoryActualAmount[]
): Map<string, number|null> {
  return new Map(rows.map(row=>[row.id,row.amount===null?null:parseMoney(row.consumptionAmount??row.amount)]));
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

async function fetchContributors(actor:string,categoryIds:string[],startDate:Date,endDate:Date,accountIds:string[],personId?:string) {
  const activity=await fetchFinancialActivity(actor,{startDate,endDate,accountIds,personId});
  const merchants=new Map<string,Map<string,{name:string;amount:number;transactionCount:number}>>();
  const transactionsByCategory=new Map<string,Map<string,BudgetTransactionContributor>>();
  const drivers=new Map<string,DriverTransaction[]>();
  const unknownRecurring=new Set<string>();
  for(const entry of activity.entries) {
    if(entry.kind!=="consumption" || !categoryIds.includes(entry.categoryId)) continue;
    const merchantName=entry.merchant||entry.description||"Unknown merchant";
    const byMerchant=merchants.get(entry.categoryId)??new Map();
    const merchant=byMerchant.get(merchantName)??{name:merchantName,amount:0,transactionCount:0};
    merchant.amount+=entry.amount;merchant.transactionCount++;
    byMerchant.set(merchantName,merchant);merchants.set(entry.categoryId,byMerchant);
    if(entry.recurrenceKnown===false) unknownRecurring.add(entry.categoryId);
    if(entry.transactionId) {
      const byTransaction=transactionsByCategory.get(entry.categoryId)??new Map();
      const transaction=byTransaction.get(entry.transactionId)??{id:entry.transactionId,description:entry.description??null,
        merchant:entry.merchant??null,bookedAt:entry.date,amount:0,recurringName:entry.recurringName??null};
      transaction.amount+=entry.amount;byTransaction.set(entry.transactionId,transaction);
      transactionsByCategory.set(entry.categoryId,byTransaction);
    }
    const rows=drivers.get(entry.categoryId)??[];
    rows.push({amount:entry.amount,isRecurring:!!entry.recurringName});drivers.set(entry.categoryId,rows);
  }
  return {
    topMerchants:new Map([...merchants].map(([id,rows])=>[id,[...rows.values()].filter(row=>row.amount>0).sort((a,b)=>b.amount-a.amount).slice(0,3)])),
    topTransactionsByCategory:new Map([...transactionsByCategory].map(([id,rows])=>[id,[...rows.values()].filter(row=>row.amount>0).sort((a,b)=>b.amount-a.amount).slice(0,3)])),
    driverTransactionsByCategory:drivers,unknownRecurring,
  };
}

export async function fetchBudgetInsights(
  userId: string,
  {
    monthKey,
    startDate,
    endDate,
    accountIds,
    categories: overBudgetCategories,
    personId,
  }: FetchBudgetInsightsOptions
): Promise<BudgetCategoryInsight[]> {
  if (overBudgetCategories.length === 0) {
    return [];
  }

  const normalizedAccountIds = normalizeAccountIds(accountIds);
  const categoryIds = overBudgetCategories.map((category) => category.categoryId);
  const previousWindows = previousMonthWindows(monthKey, 3);
  const sameMonthLastYear = sameMonthLastYearWindow(monthKey);

  const [previousRows, sameMonthLastYearRows, transactionContributors] =
    await Promise.all([
      Promise.all(
        previousWindows.map((window) =>
          fetchCategoryActualAmounts(userId, {
            ...window,
            accountIds: normalizedAccountIds,
            includeUncategorized: false,
            personId,
          })
        )
      ),
      fetchCategoryActualAmounts(userId, {
        ...sameMonthLastYear,
        accountIds: normalizedAccountIds,
        includeUncategorized: false,
        personId,
      }),
      fetchContributors(
        userId,
        categoryIds,
        startDate,
        endDate,
        normalizedAccountIds,personId
      ),
    ]);

  const previousByCategory = previousRows.map(groupAmountsByCategory);
  const sameMonthLastYearByCategory = groupAmountsByCategory(sameMonthLastYearRows);

  return overBudgetCategories.map((category) => {
    const previousAmounts = previousByCategory.flatMap((rows) => {
      const amount = rows.get(category.categoryId);
      return amount == null ? [] : [amount];
    });
    const previousMonthAmount = previousByCategory[0]?.get(category.categoryId) ?? null;
    const merchantContributors = transactionContributors.topMerchants.get(category.categoryId) ?? [];
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
      explanation: transactionContributors.unknownRecurring.has(category.categoryId) ? "Above your personal category plan. Recurring attribution is unavailable for some shared records." : buildBudgetInsightExplanation({
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
