"use server";

import { categoryAccess, categorySelectionHidden } from "@/lib/household/category-access";
import { revalidatePath } from "next/cache";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { budgetLimits, categories, users } from "@/lib/db/schema";
import { requireAuth } from "@/lib/household/financial-auth";
import {
  fetchBudgetInsights,
  type BudgetCategoryInsight,
} from "@/lib/spending/budget-insights";
import { fetchCategoryActualAmounts } from "@/lib/spending/category-actuals";

export interface BudgetLineInput {
  categoryId: string;
  plannedAmount: number;
  notes?: string;
}

export interface BudgetLine {
  categoryId: string;
  categoryName: string;
  categoryColor: string | null;
  categoryIcon: string | null;
  plannedAmount: number;
  consumptionAmount?:number|null;
  capitalAmount?:number|null;
  actualAmount: number | null;
  previousMonthActualAmount: number | null;
  remainingAmount: number | null;
  varianceAmount: number | null;
  usedPct: number | null;
  notes: string | null;
  insight: BudgetCategoryInsight | null;
}

export interface BudgetData {
  monthKey: string;
  currency: string;
  accountIds: string[];
  personId?: string;
  unclassifiedActuals?:{amount:number|null;consumptionAmount:number|null;capitalAmount:number|null};
  totals: {
    plannedAmount: number;
    actualAmount: number | null;
    remainingAmount: number | null;
    varianceAmount: number | null;
    usedPct: number | null;
    categoriesOverBudget: number | null;
  };
  lines: BudgetLine[];
}

interface BudgetDataOptions {
  accountIds?: string[];
  personId?: string;
}

export interface BudgetActionResult {
  success: boolean;
  error?: string;
}

export interface FutureBudgetPlanPreview {
  startMonthKey: string;
  endMonthKey: string;
  monthCount: number;
  existingMonthCount: number;
}

export interface FutureBudgetPlanResult extends BudgetActionResult {
  preview?: FutureBudgetPlanPreview;
  appliedMonthCount?: number;
  requiresConfirmation?: boolean;
}

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function normalizeBudgetMonthKey(monthKey?: string): string {
  if (monthKey && /^\d{4}-\d{2}$/.test(monthKey)) {
    const month = Number(monthKey.slice(5, 7));
    if (month >= 1 && month <= 12) {
      return monthKey;
    }
  }

  return currentMonthKey();
}

function budgetMonthDate(monthKey: string): string {
  return `${monthKey}-01`;
}

function budgetMonthRange(monthKey: string): {
  start: Date;
  end: Date;
  startDate: string;
  endDate: string;
} {
  const year = Number(monthKey.slice(0, 4));
  const monthIndex = Number(monthKey.slice(5, 7)) - 1;
  const start = new Date(year, monthIndex, 1);
  const end = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);

  return {
    start,
    end,
    startDate: `${monthKey}-01`,
    endDate: `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`,
  };
}

function previousMonthKey(monthKey: string): string {
  const year = Number(monthKey.slice(0, 4));
  const monthIndex = Number(monthKey.slice(5, 7)) - 1;
  const date = new Date(year, monthIndex - 1, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function nextMonthKeys(monthKey: string, monthCount: number): string[] {
  const year = Number(monthKey.slice(0, 4));
  const monthIndex = Number(monthKey.slice(5, 7)) - 1;

  return Array.from({ length: monthCount }, (_, index) => {
    const date = new Date(year, monthIndex + index + 1, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  });
}

function normalizeFutureMonthCount(monthCount: number): number | null {
  return Number.isInteger(monthCount) && monthCount >= 1 && monthCount <= 12
    ? monthCount
    : null;
}

function canApplyBudgetForward(monthKey: string): boolean {
  return monthKey >= currentMonthKey();
}

function parseMoney(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeAccountIds(accountIds?: string[]): string[] {
  if (!accountIds?.length) {
    return [];
  }

  return Array.from(new Set(accountIds.map((id) => id.trim()).filter(Boolean)));
}

async function getUserCurrency(userId: string): Promise<string> {
  const result = await db
    .select({ functionalCurrency: users.functionalCurrency })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return result[0]?.functionalCurrency || "EUR";
}

export async function getBudgetData(
  monthKeyInput?: string,
  options: BudgetDataOptions = {}
): Promise<BudgetData> {
  const userId = await requireAuth();
  const monthKey = normalizeBudgetMonthKey(monthKeyInput);
  const accountIds = normalizeAccountIds(options.accountIds);
  const personId = options.personId?.trim() || undefined;

  if (!userId) {
    return {
      monthKey,
      currency: "EUR",
      accountIds,
      personId,
      totals: {
        plannedAmount: 0,
        actualAmount: 0,
        remainingAmount: 0,
        varianceAmount: 0,
        usedPct: 0,
        categoriesOverBudget: 0,
      },
      lines: [],
    };
  }

  const { start, end } = budgetMonthRange(monthKey);
  const previousMonth = previousMonthKey(monthKey);
  const { start: previousStart, end: previousEnd } = budgetMonthRange(previousMonth);
  const month = budgetMonthDate(monthKey);

  const [expenseCategories, budgetRows, actualRows, previousActualRows, currency] = await Promise.all([
    db
      .select({
        id: categories.id,
        name: categories.name,
        color: categories.color,
        icon: categories.icon,
      })
      .from(categories)
      .where(
        and(
          categoryAccess(userId),
          or(eq(categories.categoryType, "expense"),sql`EXISTS(SELECT 1 FROM budget_limits personal_plan WHERE personal_plan.category_id=categories.id AND personal_plan.user_id=${userId})`),
          or(sql`${categorySelectionHidden(userId)}=false`,sql`EXISTS(SELECT 1 FROM budget_limits personal_plan WHERE personal_plan.category_id=categories.id AND personal_plan.user_id=${userId})`)
        )
      )
      .orderBy(asc(categories.name)),
    db
      .select({
        categoryId: budgetLimits.categoryId,
        plannedAmount: budgetLimits.plannedAmount,
        notes: budgetLimits.notes,
      })
      .from(budgetLimits)
      .where(and(eq(budgetLimits.userId, userId), eq(budgetLimits.month, month))),
    fetchCategoryActualAmounts(userId, {
      startDate: start,
      endDate: end,
      accountIds,
      personId,
      includeUncategorized: true,
    }),
    fetchCategoryActualAmounts(userId, {
      startDate: previousStart,
      endDate: previousEnd,
      accountIds,
      personId,
      includeUncategorized: true,
    }),
    getUserCurrency(userId),
  ]);

  const budgetByCategory = new Map(
    budgetRows.map((row) => [
      row.categoryId,
      {
        plannedAmount: parseMoney(row.plannedAmount),
        notes: row.notes,
      },
    ])
  );
  const actualByCategory = new Map(
    actualRows.map((row) => [row.id, row.amount===null?null:parseMoney(row.amount)])
  );
  const previousActualByCategory = new Map(
    previousActualRows.map((row) => [row.id, row.amount===null?null:parseMoney(row.amount)])
  );

  const actualDetails=new Map(actualRows.map(row=>[row.id,row]));
  const planningIds=new Set(expenseCategories.map(category=>category.id));
  const planningCategories=[...expenseCategories,...actualRows.filter(row=>row.id!=="uncategorized"&&!planningIds.has(row.id)&&typeof row.name==="string")];
  const known=(map:Map<string,number|null>,id:string)=>map.has(id)?map.get(id)!:0;
  const lines = planningCategories.map(category=>{
    const budget=budgetByCategory.get(category.id);
    const plannedAmount=budget?.plannedAmount??0;
    const observed=known(actualByCategory,category.id);
    const actualAmount=observed===null?null:roundMoney(observed);
    const prior=known(previousActualByCategory,category.id);
    const detail=actualDetails.get(category.id);
    return {
      categoryId:category.id,categoryName:category.name,categoryColor:category.color,categoryIcon:category.icon,
      plannedAmount,actualAmount,
      consumptionAmount:detail?.consumptionAmount===undefined?actualAmount:detail.consumptionAmount,
      capitalAmount:detail?.capitalAmount===undefined?0:detail.capitalAmount,
      previousMonthActualAmount:prior===null?null:roundMoney(prior),
      remainingAmount:actualAmount===null?null:roundMoney(plannedAmount-actualAmount),
      varianceAmount:actualAmount===null?null:roundMoney(actualAmount-plannedAmount),
      usedPct:actualAmount===null?null:plannedAmount>0?Math.round(actualAmount/plannedAmount*100):0,
      notes:budget?.notes??null,insight:null,
    };
  });
  const unclassified=actualDetails.get("uncategorized");
  const unclassifiedActuals={amount:unclassified?.amount===null?null:unclassified?.amount??0,
    consumptionAmount:unclassified?.consumptionAmount===null?null:unclassified?.consumptionAmount??unclassified?.amount??0,
    capitalAmount:unclassified?.capitalAmount===null?null:unclassified?.capitalAmount??0};
  const complete=lines.every(line=>line.actualAmount!==null)&&unclassifiedActuals.amount!==null;
  const plannedAmount=roundMoney(lines.reduce((sum,line)=>sum+line.plannedAmount,0));
  const actualAmount=complete?roundMoney(lines.reduce((sum,line)=>sum+(line.actualAmount??0),unclassifiedActuals.amount??0)):null;
  const totals={plannedAmount,actualAmount,
    remainingAmount:actualAmount===null?null:roundMoney(plannedAmount-actualAmount),
    varianceAmount:actualAmount===null?null:roundMoney(actualAmount-plannedAmount),
    usedPct:actualAmount===null?null:plannedAmount>0?Math.round(actualAmount/plannedAmount*100):0,
    categoriesOverBudget:complete?lines.filter(line=>line.actualAmount!==null&&line.plannedAmount>0&&line.actualAmount>line.plannedAmount).length:null};
  const overBudgetCategories=lines.flatMap(line=>line.actualAmount!==null&&line.varianceAmount!==null
    &&line.capitalAmount===0&&line.plannedAmount>0&&line.actualAmount>line.plannedAmount?[{
      categoryId:line.categoryId,categoryName:line.categoryName,plannedAmount:line.plannedAmount,
      actualAmount:line.actualAmount,overspendAmount:line.varianceAmount,
    }]:[]);

  const insights = await fetchBudgetInsights(userId, {
    monthKey,
    startDate: start,
    endDate: end,
    accountIds,
    categories: overBudgetCategories,
    personId,
  });
  const insightsByCategory = new Map(
    insights.map((insight) => [insight.categoryId, insight])
  );

  return {
    monthKey,
    currency,
    accountIds,
    personId,
    totals,
    unclassifiedActuals,
    lines: lines.map((line) => ({
      ...line,
      insight: insightsByCategory.get(line.categoryId) ?? null,
    })),
  };
}

export async function saveBudgetLines(
  monthKeyInput: string,
  lines: BudgetLineInput[]
): Promise<BudgetActionResult> {
  const userId = await requireAuth();

  if (!userId) {
    return { success: false, error: "Not authenticated" };
  }

  const monthKey = normalizeBudgetMonthKey(monthKeyInput);
  const month = budgetMonthDate(monthKey);
  const normalizedLines = lines.map((line) => ({
    categoryId: line.categoryId,
    plannedAmount: Math.max(0, Math.round(parseMoney(line.plannedAmount) * 100) / 100),
    notes: line.notes?.trim() || null,
  }));
  const categoryIds = Array.from(new Set(normalizedLines.map((line) => line.categoryId)));

  if (categoryIds.length === 0) {
    return { success: true };
  }

  const ownedCategories = await db
    .select({ id: categories.id })
    .from(categories)
    .where(
      and(
        categoryAccess(userId),
        inArray(categories.id, categoryIds)
      )
    );

  const ownedCategoryIds = new Set(ownedCategories.map((category) => category.id));
  if (ownedCategoryIds.size !== categoryIds.length) {
    return { success: false, error: "One or more budget categories could not be found" };
  }

  try {
    await db.transaction(async (tx) => {
      for (const line of normalizedLines) {
        if (line.plannedAmount === 0 && !line.notes) {
          await tx
            .delete(budgetLimits)
            .where(
              and(
                eq(budgetLimits.userId, userId),
                eq(budgetLimits.month, month),
                eq(budgetLimits.categoryId, line.categoryId)
              )
            );
          continue;
        }

        await tx
          .insert(budgetLimits)
          .values({
            userId,
            categoryId: line.categoryId,
            month,
            plannedAmount: line.plannedAmount.toFixed(2),
            notes: line.notes,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [budgetLimits.userId, budgetLimits.month, budgetLimits.categoryId],
            set: {
              plannedAmount: line.plannedAmount.toFixed(2),
              notes: line.notes,
              updatedAt: new Date(),
            },
          });
      }
    });

    revalidatePath("/budget");
    revalidatePath("/");
    return { success: true };
  } catch (error) {
    console.error("Failed to save budget lines:", error);
    return { success: false, error: "Failed to save budget" };
  }
}

export async function previewFutureBudgetPlan(
  monthKeyInput: string,
  monthCountInput: number
): Promise<FutureBudgetPlanResult> {
  const userId = await requireAuth();
  const monthCount = normalizeFutureMonthCount(monthCountInput);

  if (!userId) return { success: false, error: "Not authenticated" };
  if (!monthCount) return { success: false, error: "Choose between 1 and 12 months" };

  const monthKey = normalizeBudgetMonthKey(monthKeyInput);
  if (!canApplyBudgetForward(monthKey)) {
    return {
      success: false,
      error: "Choose the current month or a future month to apply a budget forward",
    };
  }

  const targetMonthKeys = nextMonthKeys(monthKey, monthCount);
  const existingRows = await db
    .select({ month: budgetLimits.month })
    .from(budgetLimits)
    .where(
      and(
        eq(budgetLimits.userId, userId),
        inArray(budgetLimits.month, targetMonthKeys.map(budgetMonthDate))
      )
    );

  return {
    success: true,
    preview: {
      startMonthKey: targetMonthKeys[0],
      endMonthKey: targetMonthKeys[targetMonthKeys.length - 1],
      monthCount,
      existingMonthCount: new Set(existingRows.map((row) => String(row.month))).size,
    },
  };
}

/** Replaces future planned budgets only; actuals and transactions are never read or changed. */
export async function applyBudgetToFutureMonths(
  monthKeyInput: string,
  monthCountInput: number,
  lines: Array<Pick<BudgetLineInput, "categoryId" | "plannedAmount">>,
  confirmOverwrite = false
): Promise<FutureBudgetPlanResult> {
  const userId = await requireAuth();
  const monthCount = normalizeFutureMonthCount(monthCountInput);

  if (!userId) return { success: false, error: "Not authenticated" };
  if (!monthCount) return { success: false, error: "Choose between 1 and 12 months" };

  const monthKey = normalizeBudgetMonthKey(monthKeyInput);
  if (!canApplyBudgetForward(monthKey)) {
    return {
      success: false,
      error: "Choose the current month or a future month to apply a budget forward",
    };
  }

  const targetMonthKeys = nextMonthKeys(monthKey, monthCount);
  const targetMonths = targetMonthKeys.map(budgetMonthDate);
  const plannedByCategory = new Map<string, number>();
  for (const line of lines) {
    if (line.categoryId) {
      plannedByCategory.set(
        line.categoryId,
        Math.max(0, Math.round(parseMoney(line.plannedAmount) * 100) / 100)
      );
    }
  }
  const categoryIds = [...plannedByCategory.keys()];

  if (categoryIds.length > 0) {
    const ownedCategories = await db
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          categoryAccess(userId),
            inArray(categories.id, categoryIds)
        )
      );
    if (ownedCategories.length !== categoryIds.length) {
      return { success: false, error: "One or more budget categories could not be found" };
    }
  }

  try {
    const result = await db.transaction(async (tx) => {
      const existingRows = await tx
        .select({ month: budgetLimits.month })
        .from(budgetLimits)
        .where(and(eq(budgetLimits.userId, userId), inArray(budgetLimits.month, targetMonths)));
      const preview: FutureBudgetPlanPreview = {
        startMonthKey: targetMonthKeys[0],
        endMonthKey: targetMonthKeys[targetMonthKeys.length - 1],
        monthCount,
        existingMonthCount: new Set(existingRows.map((row) => String(row.month))).size,
      };

      if (preview.existingMonthCount > 0 && !confirmOverwrite) {
        return { success: false, requiresConfirmation: true, preview };
      }

      for (const targetMonth of targetMonths) {
        await tx
          .delete(budgetLimits)
          .where(and(eq(budgetLimits.userId, userId), eq(budgetLimits.month, targetMonth)));
        for (const [categoryId, plannedAmount] of plannedByCategory) {
          if (plannedAmount === 0) continue;
          await tx.insert(budgetLimits).values({
            userId,
            categoryId,
            month: targetMonth,
            plannedAmount: plannedAmount.toFixed(2),
            notes: null,
            updatedAt: new Date(),
          });
        }
      }
      return { success: true, preview, appliedMonthCount: monthCount };
    });

    if (!result.success) return result;
    revalidatePath("/budget");
    revalidatePath("/");
    return result;
  } catch (error) {
    console.error("Failed to apply budget to future months:", error);
    return { success: false, error: "Failed to apply budget to future months" };
  }
}
