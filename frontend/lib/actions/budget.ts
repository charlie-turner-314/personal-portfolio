"use server";

import { revalidatePath } from "next/cache";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { budgetLimits, categories, users } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-helpers";
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
  actualAmount: number;
  remainingAmount: number;
  varianceAmount: number;
  usedPct: number;
  notes: string | null;
  insight: BudgetCategoryInsight | null;
}

export interface BudgetData {
  monthKey: string;
  currency: string;
  accountIds: string[];
  totals: {
    plannedAmount: number;
    actualAmount: number;
    remainingAmount: number;
    varianceAmount: number;
    usedPct: number;
    categoriesOverBudget: number;
  };
  lines: BudgetLine[];
}

interface BudgetDataOptions {
  accountIds?: string[];
}

export interface BudgetActionResult {
  success: boolean;
  error?: string;
}

export interface CopyPreviousMonthBudgetResult extends BudgetActionResult {
  copiedCount?: number;
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

  if (!userId) {
    return {
      monthKey,
      currency: "EUR",
      accountIds,
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
  const month = budgetMonthDate(monthKey);

  const [expenseCategories, budgetRows, actualRows, currency] = await Promise.all([
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
          eq(categories.userId, userId),
          eq(categories.categoryType, "expense"),
          or(eq(categories.hideFromSelection, false), isNull(categories.hideFromSelection))
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
      includeUncategorized: false,
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
    actualRows.map((row) => [row.id, parseMoney(row.amount)])
  );

  const lines = expenseCategories.map((category) => {
    const budget = budgetByCategory.get(category.id);
    const plannedAmount = budget?.plannedAmount ?? 0;
    const actualAmount = roundMoney(actualByCategory.get(category.id) ?? 0);
    const remainingAmount = roundMoney(plannedAmount - actualAmount);
    const usedPct = plannedAmount > 0 ? Math.round((actualAmount / plannedAmount) * 100) : 0;

    return {
      categoryId: category.id,
      categoryName: category.name,
      categoryColor: category.color,
      categoryIcon: category.icon,
      plannedAmount,
      actualAmount,
      remainingAmount,
      varianceAmount: roundMoney(actualAmount - plannedAmount),
      usedPct,
      notes: budget?.notes ?? null,
      insight: null,
    };
  });

  const totals = lines.reduce(
    (acc, line) => {
      acc.plannedAmount += line.plannedAmount;
      acc.actualAmount += line.actualAmount;
      if (line.plannedAmount > 0 && line.actualAmount > line.plannedAmount) {
        acc.categoriesOverBudget += 1;
      }
      return acc;
    },
    {
      plannedAmount: 0,
      actualAmount: 0,
      remainingAmount: 0,
      varianceAmount: 0,
      usedPct: 0,
      categoriesOverBudget: 0,
    }
  );

  totals.plannedAmount = roundMoney(totals.plannedAmount);
  totals.actualAmount = roundMoney(totals.actualAmount);
  totals.remainingAmount = roundMoney(totals.plannedAmount - totals.actualAmount);
  totals.varianceAmount = roundMoney(totals.actualAmount - totals.plannedAmount);
  totals.usedPct =
    totals.plannedAmount > 0
      ? Math.round((totals.actualAmount / totals.plannedAmount) * 100)
      : 0;

  const overBudgetCategories = lines
    .filter((line) => line.plannedAmount > 0 && line.actualAmount > line.plannedAmount)
    .map((line) => ({
      categoryId: line.categoryId,
      categoryName: line.categoryName,
      plannedAmount: line.plannedAmount,
      actualAmount: line.actualAmount,
      overspendAmount: line.varianceAmount,
    }));

  const insights = await fetchBudgetInsights(userId, {
    monthKey,
    startDate: start,
    endDate: end,
    accountIds,
    categories: overBudgetCategories,
  });
  const insightsByCategory = new Map(
    insights.map((insight) => [insight.categoryId, insight])
  );

  return {
    monthKey,
    currency,
    accountIds,
    totals,
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
        eq(categories.userId, userId),
        eq(categories.categoryType, "expense"),
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

export async function copyPreviousMonthBudget(
  monthKeyInput: string
): Promise<CopyPreviousMonthBudgetResult> {
  const userId = await requireAuth();

  if (!userId) {
    return { success: false, error: "Not authenticated" };
  }

  const monthKey = normalizeBudgetMonthKey(monthKeyInput);
  const sourceMonth = budgetMonthDate(previousMonthKey(monthKey));
  const targetMonth = budgetMonthDate(monthKey);

  const sourceRows = await db
    .select({
      categoryId: budgetLimits.categoryId,
      plannedAmount: budgetLimits.plannedAmount,
      notes: budgetLimits.notes,
    })
    .from(budgetLimits)
    .innerJoin(categories, eq(budgetLimits.categoryId, categories.id))
    .where(
      and(
        eq(budgetLimits.userId, userId),
        eq(budgetLimits.month, sourceMonth),
        eq(categories.userId, userId),
        eq(categories.categoryType, "expense"),
        or(eq(categories.hideFromSelection, false), isNull(categories.hideFromSelection))
      )
    );

  try {
    await db.transaction(async (tx) => {
      await tx
        .delete(budgetLimits)
        .where(and(eq(budgetLimits.userId, userId), eq(budgetLimits.month, targetMonth)));

      for (const row of sourceRows) {
        await tx.insert(budgetLimits).values({
          userId,
          categoryId: row.categoryId,
          month: targetMonth,
          plannedAmount: parseMoney(row.plannedAmount).toFixed(2),
          notes: row.notes,
          updatedAt: new Date(),
        });
      }
    });

    revalidatePath("/budget");
    revalidatePath("/");
    return { success: true, copiedCount: sourceRows.length };
  } catch (error) {
    console.error("Failed to copy previous budget:", error);
    return { success: false, error: "Failed to copy previous budget" };
  }
}
