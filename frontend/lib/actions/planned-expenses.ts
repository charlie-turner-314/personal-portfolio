"use server";

import { revalidatePath } from "next/cache";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { requireAuth } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import {
  accounts,
  categories,
  plannedExpenseTransactionLinks,
  plannedExpenses,
  transactions,
  users,
} from "@/lib/db/schema";
import {
  calculateMonthlyProvision,
  dateKey,
  generateOccurrences,
  parseDateKey,
  roundMoney,
  type PlannedExpenseRecurrence,
  type PlannedExpenseScheduleInput,
} from "@/lib/planned-expenses/schedule";

export type { PlannedExpenseRecurrence } from "@/lib/planned-expenses/schedule";

export interface PlannedExpenseActionResult {
  success: boolean;
  error?: string;
  id?: string;
}

export interface PlannedExpenseInput {
  name: string;
  amount: number;
  categoryId: string;
  accountId: string;
  dueDate: string;
  recurrenceType: PlannedExpenseRecurrence;
  customIntervalMonths?: number | null;
  sinkingFundTargetAmount?: number | null;
  sinkingFundStartDate?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

export interface PlannedExpenseOption {
  id: string;
  name: string;
}

export interface PlannedExpenseFormOptions {
  categories: PlannedExpenseOption[];
  accounts: PlannedExpenseOption[];
  currency: string;
}

export interface PlannedExpenseListItem {
  id: string;
  name: string;
  amount: number;
  currency: string;
  categoryId: string;
  categoryName: string;
  accountId: string;
  accountName: string;
  dueDate: string;
  recurrenceType: PlannedExpenseRecurrence;
  customIntervalMonths: number | null;
  sinkingFundTargetAmount: number;
  sinkingFundStartDate: string;
  notes: string | null;
  isActive: boolean;
  monthlyProvision: number;
  actualPaidThisMonth: number;
  nextDueDate: string | null;
  upcomingAmountThisMonth: number;
}

export interface BudgetPlannedExpenseSummary {
  monthKey: string;
  currency: string;
  accountIds: string[];
  totals: {
    monthlyProvision: number;
    actualPaidThisMonth: number;
    upcomingAmountThisMonth: number;
    activeCount: number;
  };
  items: PlannedExpenseListItem[];
}

export interface UpcomingPlannedExpenseItem {
  id: string;
  name: string;
  categoryName: string;
  accountName: string;
  dueDate: string;
  amount: number;
  amountPaid: number;
  amountRemaining: number;
}

export interface UpcomingPlannedExpensesData {
  currency: string;
  generatedAt: string;
  horizons: {
    days: 30 | 60 | 90;
    total: number;
    items: UpcomingPlannedExpenseItem[];
  }[];
}

export interface PlannedExpenseTransactionCandidate {
  id: string;
  amount: number;
  description: string | null;
  merchant: string | null;
  bookedAt: string;
}

const RECURRENCE_TYPES: PlannedExpenseRecurrence[] = [
  "one_off",
  "monthly",
  "quarterly",
  "annual",
  "custom",
];

function parseMoney(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function normalizeMonthKey(monthKey?: string): string {
  if (monthKey && /^\d{4}-\d{2}$/.test(monthKey)) {
    const month = Number(monthKey.slice(5, 7));
    if (month >= 1 && month <= 12) return monthKey;
  }
  return currentMonthKey();
}

function monthRange(monthKey: string): { start: string; end: string; startDate: Date; endDate: Date } {
  const year = Number(monthKey.slice(0, 4));
  const monthIndex = Number(monthKey.slice(5, 7)) - 1;
  const end = new Date(Date.UTC(year, monthIndex + 1, 0));
  return {
    start: `${monthKey}-01`,
    end: dateKey(end),
    startDate: new Date(year, monthIndex, 1),
    endDate: new Date(year, monthIndex + 1, 0, 23, 59, 59, 999),
  };
}

function normalizeAccountIds(accountIds?: string[]): string[] {
  if (!accountIds?.length) return [];
  return Array.from(new Set(accountIds.map((id) => id.trim()).filter(Boolean)));
}

function normalizeDateKey(value?: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = parseDateKey(value);
  return Number.isNaN(date.getTime()) ? null : value;
}

function normalizeInput(
  input: PlannedExpenseInput
): (PlannedExpenseInput & { amount: number; sinkingFundTargetAmount: number; dueDate: string; sinkingFundStartDate: string }) | { error: string } {
  const name = input.name.trim();
  const dueDate = normalizeDateKey(input.dueDate);
  const sinkingFundStartDate =
    normalizeDateKey(input.sinkingFundStartDate) ?? dueDate ?? dateKey(new Date());
  const amount = roundMoney(parseMoney(input.amount));
  const sinkingFundTargetAmount = roundMoney(
    parseMoney(input.sinkingFundTargetAmount ?? input.amount)
  );
  const recurrenceType = input.recurrenceType;
  const customIntervalMonths =
    input.customIntervalMonths == null ? null : Number(input.customIntervalMonths);

  if (!name) return { error: "Name is required" };
  if (!input.categoryId) return { error: "Category is required" };
  if (!input.accountId) return { error: "Account is required" };
  if (!dueDate) return { error: "Due date is required" };
  if (amount <= 0) return { error: "Amount must be greater than zero" };
  if (sinkingFundTargetAmount <= 0) {
    return { error: "Sinking fund target must be greater than zero" };
  }
  if (!RECURRENCE_TYPES.includes(recurrenceType)) {
    return { error: "Unsupported recurrence type" };
  }
  if (
    recurrenceType === "custom" &&
    (customIntervalMonths === null ||
      !Number.isInteger(customIntervalMonths) ||
      customIntervalMonths < 1 ||
      customIntervalMonths > 120)
  ) {
    return { error: "Custom interval must be between 1 and 120 months" };
  }

  return {
    ...input,
    name,
    amount,
    dueDate,
    recurrenceType,
    customIntervalMonths: recurrenceType === "custom" ? customIntervalMonths : null,
    sinkingFundTargetAmount,
    sinkingFundStartDate,
    notes: input.notes?.trim() || null,
  };
}

async function getUserCurrency(userId: string): Promise<string> {
  const result = await db
    .select({ functionalCurrency: users.functionalCurrency })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return result[0]?.functionalCurrency || "EUR";
}

async function validateOwnedAccountAndCategory(
  userId: string,
  categoryId: string,
  accountId: string
): Promise<string | null> {
  const [categoryRows, accountRows] = await Promise.all([
    db
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.id, categoryId),
          eq(categories.userId, userId),
          eq(categories.categoryType, "expense"),
          or(eq(categories.hideFromSelection, false), isNull(categories.hideFromSelection))
        )
      )
      .limit(1),
    db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
      .limit(1),
  ]);

  if (!categoryRows[0]) return "Expense category could not be found";
  if (!accountRows[0]) return "Account could not be found";
  return null;
}

export async function getPlannedExpenseFormOptions(): Promise<PlannedExpenseFormOptions> {
  const userId = await requireAuth();
  if (!userId) {
    return { categories: [], accounts: [], currency: "EUR" };
  }

  const [categoryRows, accountRows, currency] = await Promise.all([
    db
      .select({ id: categories.id, name: categories.name })
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
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.isActive, true)))
      .orderBy(asc(accounts.name)),
    getUserCurrency(userId),
  ]);

  return {
    categories: categoryRows,
    accounts: accountRows,
    currency,
  };
}

async function fetchPlannedExpenseRows(userId: string, accountIds: string[] = []) {
  const conditions = [eq(plannedExpenses.userId, userId)];
  if (accountIds.length) {
    conditions.push(inArray(plannedExpenses.accountId, accountIds));
  }

  return db
    .select({
      id: plannedExpenses.id,
      name: plannedExpenses.name,
      amount: plannedExpenses.amount,
      currency: plannedExpenses.currency,
      categoryId: plannedExpenses.categoryId,
      categoryName: categories.name,
      accountId: plannedExpenses.accountId,
      accountName: accounts.name,
      dueDate: plannedExpenses.dueDate,
      recurrenceType: plannedExpenses.recurrenceType,
      customIntervalMonths: plannedExpenses.customIntervalMonths,
      sinkingFundTargetAmount: plannedExpenses.sinkingFundTargetAmount,
      sinkingFundStartDate: plannedExpenses.sinkingFundStartDate,
      notes: plannedExpenses.notes,
      isActive: plannedExpenses.isActive,
    })
    .from(plannedExpenses)
    .innerJoin(categories, eq(plannedExpenses.categoryId, categories.id))
    .innerJoin(accounts, eq(plannedExpenses.accountId, accounts.id))
    .where(and(...conditions))
    .orderBy(asc(plannedExpenses.dueDate), asc(plannedExpenses.name));
}

function toScheduleInput(row: Awaited<ReturnType<typeof fetchPlannedExpenseRows>>[number]): PlannedExpenseScheduleInput {
  return {
    id: row.id,
    name: row.name,
    amount: parseMoney(row.amount),
    recurrenceType: row.recurrenceType as PlannedExpenseRecurrence,
    customIntervalMonths: row.customIntervalMonths,
    dueDate: row.dueDate,
    sinkingFundTargetAmount: parseMoney(row.sinkingFundTargetAmount),
    sinkingFundStartDate: row.sinkingFundStartDate,
  };
}

async function fetchPaidByExpenseForMonth(
  userId: string,
  monthKey: string,
  accountIds: string[]
): Promise<Map<string, number>> {
  const { startDate, endDate } = monthRange(monthKey);
  const conditions = [
    eq(plannedExpenseTransactionLinks.userId, userId),
    gte(transactions.bookedAt, startDate),
    lte(transactions.bookedAt, endDate),
  ];

  if (accountIds.length) {
    conditions.push(inArray(transactions.accountId, accountIds));
  }

  const rows = await db
    .select({
      plannedExpenseId: plannedExpenseTransactionLinks.plannedExpenseId,
      amount: sql<string>`COALESCE(SUM(${plannedExpenseTransactionLinks.amountApplied}), 0)`,
    })
    .from(plannedExpenseTransactionLinks)
    .innerJoin(
      transactions,
      eq(plannedExpenseTransactionLinks.transactionId, transactions.id)
    )
    .where(and(...conditions))
    .groupBy(plannedExpenseTransactionLinks.plannedExpenseId);

  return new Map(rows.map((row) => [row.plannedExpenseId, parseMoney(row.amount)]));
}

async function fetchPaidByOccurrence(
  userId: string,
  fromDateKey: string,
  toDateKey: string,
  accountIds: string[] = []
): Promise<Map<string, number>> {
  const conditions = [
    eq(plannedExpenseTransactionLinks.userId, userId),
    gte(plannedExpenseTransactionLinks.occurrenceDueDate, fromDateKey),
    lte(plannedExpenseTransactionLinks.occurrenceDueDate, toDateKey),
  ];

  if (accountIds.length) {
    conditions.push(inArray(transactions.accountId, accountIds));
  }

  const rows = await db
    .select({
      plannedExpenseId: plannedExpenseTransactionLinks.plannedExpenseId,
      occurrenceDueDate: plannedExpenseTransactionLinks.occurrenceDueDate,
      amount: sql<string>`COALESCE(SUM(${plannedExpenseTransactionLinks.amountApplied}), 0)`,
    })
    .from(plannedExpenseTransactionLinks)
    .innerJoin(
      transactions,
      eq(plannedExpenseTransactionLinks.transactionId, transactions.id)
    )
    .where(and(...conditions))
    .groupBy(
      plannedExpenseTransactionLinks.plannedExpenseId,
      plannedExpenseTransactionLinks.occurrenceDueDate
    );

  return new Map(
    rows.map((row) => [
      `${row.plannedExpenseId}:${row.occurrenceDueDate}`,
      parseMoney(row.amount),
    ])
  );
}

export async function getBudgetPlannedExpenseSummary(
  monthKeyInput?: string,
  options: { accountIds?: string[] } = {}
): Promise<BudgetPlannedExpenseSummary> {
  const userId = await requireAuth();
  const monthKey = normalizeMonthKey(monthKeyInput);
  const accountIds = normalizeAccountIds(options.accountIds);

  if (!userId) {
    return {
      monthKey,
      currency: "EUR",
      accountIds,
      totals: {
        monthlyProvision: 0,
        actualPaidThisMonth: 0,
        upcomingAmountThisMonth: 0,
        activeCount: 0,
      },
      items: [],
    };
  }

  const { start, end } = monthRange(monthKey);
  const [rows, paidByMonth, paidByOccurrence, currency] = await Promise.all([
    fetchPlannedExpenseRows(userId, accountIds),
    fetchPaidByExpenseForMonth(userId, monthKey, accountIds),
    fetchPaidByOccurrence(userId, start, end, accountIds),
    getUserCurrency(userId),
  ]);

  const items = rows.map((row) => {
    const schedule = toScheduleInput(row);
    const monthOccurrences = generateOccurrences(schedule, start, end);
    const nextDueDate = monthOccurrences[0]?.dueDate ?? null;
    const actualPaidThisMonth = roundMoney(paidByMonth.get(row.id) ?? 0);
    const upcomingAmountThisMonth = roundMoney(
      monthOccurrences.reduce((sum, occurrence) => {
        const paid = paidByOccurrence.get(`${row.id}:${occurrence.dueDate}`) ?? 0;
        return sum + Math.max(0, occurrence.amount - paid);
      }, 0)
    );

    return {
      id: row.id,
      name: row.name,
      amount: parseMoney(row.amount),
      currency: row.currency,
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      accountId: row.accountId,
      accountName: row.accountName,
      dueDate: row.dueDate,
      recurrenceType: row.recurrenceType as PlannedExpenseRecurrence,
      customIntervalMonths: row.customIntervalMonths,
      sinkingFundTargetAmount: parseMoney(row.sinkingFundTargetAmount),
      sinkingFundStartDate: row.sinkingFundStartDate,
      notes: row.notes,
      isActive: row.isActive,
      monthlyProvision: row.isActive
        ? calculateMonthlyProvision(schedule, monthKey, actualPaidThisMonth)
        : 0,
      actualPaidThisMonth,
      nextDueDate,
      upcomingAmountThisMonth,
    };
  });

  const totals = items.reduce(
    (acc, item) => {
      if (item.isActive) acc.activeCount += 1;
      acc.monthlyProvision += item.monthlyProvision;
      acc.actualPaidThisMonth += item.actualPaidThisMonth;
      acc.upcomingAmountThisMonth += item.upcomingAmountThisMonth;
      return acc;
    },
    {
      monthlyProvision: 0,
      actualPaidThisMonth: 0,
      upcomingAmountThisMonth: 0,
      activeCount: 0,
    }
  );

  return {
    monthKey,
    currency,
    accountIds,
    totals: {
      monthlyProvision: roundMoney(totals.monthlyProvision),
      actualPaidThisMonth: roundMoney(totals.actualPaidThisMonth),
      upcomingAmountThisMonth: roundMoney(totals.upcomingAmountThisMonth),
      activeCount: totals.activeCount,
    },
    items,
  };
}

export async function getPlannedExpenseList(): Promise<PlannedExpenseListItem[]> {
  const summary = await getBudgetPlannedExpenseSummary();
  return summary.items;
}

export async function createPlannedExpense(
  input: PlannedExpenseInput
): Promise<PlannedExpenseActionResult> {
  const userId = await requireAuth();
  if (!userId) return { success: false, error: "Not authenticated" };

  const normalized = normalizeInput(input);
  if ("error" in normalized) return { success: false, error: normalized.error };

  const validationError = await validateOwnedAccountAndCategory(
    userId,
    normalized.categoryId,
    normalized.accountId
  );
  if (validationError) return { success: false, error: validationError };

  const currency = await getUserCurrency(userId);

  try {
    const inserted = await db
      .insert(plannedExpenses)
      .values({
        userId,
        name: normalized.name,
        amount: normalized.amount.toFixed(2),
        currency,
        categoryId: normalized.categoryId,
        accountId: normalized.accountId,
        dueDate: normalized.dueDate,
        recurrenceType: normalized.recurrenceType,
        customIntervalMonths: normalized.customIntervalMonths,
        sinkingFundTargetAmount: normalized.sinkingFundTargetAmount.toFixed(2),
        sinkingFundStartDate: normalized.sinkingFundStartDate,
        notes: normalized.notes,
        isActive: normalized.isActive ?? true,
        updatedAt: new Date(),
      })
      .returning({ id: plannedExpenses.id });

    revalidatePath("/budget");
    revalidatePath("/");
    return { success: true, id: inserted[0]?.id };
  } catch (error) {
    console.error("Failed to create planned expense:", error);
    return { success: false, error: "Failed to create planned expense" };
  }
}

export async function updatePlannedExpense(
  id: string,
  input: PlannedExpenseInput
): Promise<PlannedExpenseActionResult> {
  const userId = await requireAuth();
  if (!userId) return { success: false, error: "Not authenticated" };

  const normalized = normalizeInput(input);
  if ("error" in normalized) return { success: false, error: normalized.error };

  const existing = await db
    .select({ id: plannedExpenses.id })
    .from(plannedExpenses)
    .where(and(eq(plannedExpenses.id, id), eq(plannedExpenses.userId, userId)))
    .limit(1);
  if (!existing[0]) return { success: false, error: "Planned expense not found" };

  const validationError = await validateOwnedAccountAndCategory(
    userId,
    normalized.categoryId,
    normalized.accountId
  );
  if (validationError) return { success: false, error: validationError };

  try {
    await db
      .update(plannedExpenses)
      .set({
        name: normalized.name,
        amount: normalized.amount.toFixed(2),
        categoryId: normalized.categoryId,
        accountId: normalized.accountId,
        dueDate: normalized.dueDate,
        recurrenceType: normalized.recurrenceType,
        customIntervalMonths: normalized.customIntervalMonths,
        sinkingFundTargetAmount: normalized.sinkingFundTargetAmount.toFixed(2),
        sinkingFundStartDate: normalized.sinkingFundStartDate,
        notes: normalized.notes,
        isActive: normalized.isActive ?? true,
        updatedAt: new Date(),
      })
      .where(and(eq(plannedExpenses.id, id), eq(plannedExpenses.userId, userId)));

    revalidatePath("/budget");
    revalidatePath("/");
    return { success: true, id };
  } catch (error) {
    console.error("Failed to update planned expense:", error);
    return { success: false, error: "Failed to update planned expense" };
  }
}

export async function deletePlannedExpense(
  id: string
): Promise<PlannedExpenseActionResult> {
  const userId = await requireAuth();
  if (!userId) return { success: false, error: "Not authenticated" };

  try {
    await db
      .delete(plannedExpenses)
      .where(and(eq(plannedExpenses.id, id), eq(plannedExpenses.userId, userId)));

    revalidatePath("/budget");
    revalidatePath("/");
    return { success: true };
  } catch (error) {
    console.error("Failed to delete planned expense:", error);
    return { success: false, error: "Failed to delete planned expense" };
  }
}

export async function linkTransactionToPlannedExpense(input: {
  plannedExpenseId: string;
  transactionId: string;
  occurrenceDueDate: string;
}): Promise<PlannedExpenseActionResult> {
  const userId = await requireAuth();
  if (!userId) return { success: false, error: "Not authenticated" };

  const occurrenceDueDate = normalizeDateKey(input.occurrenceDueDate);
  if (!occurrenceDueDate) return { success: false, error: "Occurrence due date is required" };

  const [expense] = await db
    .select({
      id: plannedExpenses.id,
      accountId: plannedExpenses.accountId,
    })
    .from(plannedExpenses)
    .where(
      and(
        eq(plannedExpenses.id, input.plannedExpenseId),
        eq(plannedExpenses.userId, userId)
      )
    )
    .limit(1);
  if (!expense) return { success: false, error: "Planned expense not found" };

  const [transaction] = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      transactionType: transactions.transactionType,
      amount: transactions.amount,
      functionalAmount: transactions.functionalAmount,
      includeInAnalytics: transactions.includeInAnalytics,
      internalTransferId: transactions.internalTransferId,
    })
    .from(transactions)
    .where(and(eq(transactions.id, input.transactionId), eq(transactions.userId, userId)))
    .limit(1);

  if (!transaction) return { success: false, error: "Transaction not found" };
  if (transaction.transactionType !== "debit") {
    return { success: false, error: "Only debit transactions can be linked" };
  }
  if (!transaction.includeInAnalytics || transaction.internalTransferId) {
    return { success: false, error: "Transaction is excluded from spending analytics" };
  }
  if (transaction.accountId !== expense.accountId) {
    return { success: false, error: "Transaction must belong to the planned expense account" };
  }

  const existingLink = await db
    .select({ id: plannedExpenseTransactionLinks.id })
    .from(plannedExpenseTransactionLinks)
    .where(eq(plannedExpenseTransactionLinks.transactionId, input.transactionId))
    .limit(1);
  if (existingLink[0]) {
    return { success: false, error: "Transaction is already linked to a planned expense" };
  }

  const amount = Math.abs(
    parseMoney(transaction.functionalAmount ?? transaction.amount)
  );

  try {
    const inserted = await db
      .insert(plannedExpenseTransactionLinks)
      .values({
        userId,
        plannedExpenseId: expense.id,
        transactionId: transaction.id,
        occurrenceDueDate,
        amountApplied: amount.toFixed(2),
      })
      .returning({ id: plannedExpenseTransactionLinks.id });

    revalidatePath("/budget");
    revalidatePath("/");
    return { success: true, id: inserted[0]?.id };
  } catch (error) {
    console.error("Failed to link transaction to planned expense:", error);
    return { success: false, error: "Failed to link transaction" };
  }
}

export async function unlinkTransactionFromPlannedExpense(
  linkId: string
): Promise<PlannedExpenseActionResult> {
  const userId = await requireAuth();
  if (!userId) return { success: false, error: "Not authenticated" };

  try {
    await db
      .delete(plannedExpenseTransactionLinks)
      .where(
        and(
          eq(plannedExpenseTransactionLinks.id, linkId),
          eq(plannedExpenseTransactionLinks.userId, userId)
        )
      );

    revalidatePath("/budget");
    revalidatePath("/");
    return { success: true };
  } catch (error) {
    console.error("Failed to unlink transaction from planned expense:", error);
    return { success: false, error: "Failed to unlink transaction" };
  }
}

export async function findTransactionsForPlannedExpense(
  plannedExpenseId: string,
  occurrenceDueDate: string
): Promise<PlannedExpenseTransactionCandidate[]> {
  const userId = await requireAuth();
  const normalizedDueDate = normalizeDateKey(occurrenceDueDate);
  if (!userId || !normalizedDueDate) return [];

  const expenseRows = await db
    .select({ accountId: plannedExpenses.accountId })
    .from(plannedExpenses)
    .where(and(eq(plannedExpenses.id, plannedExpenseId), eq(plannedExpenses.userId, userId)))
    .limit(1);
  const expense = expenseRows[0];
  if (!expense) return [];

  const dueDate = parseDateKey(normalizedDueDate);
  const fromDate = new Date(dueDate);
  fromDate.setUTCDate(fromDate.getUTCDate() - 30);
  const toDate = new Date(dueDate);
  toDate.setUTCDate(toDate.getUTCDate() + 30);

  const rows = await db
    .select({
      id: transactions.id,
      amount: transactions.amount,
      functionalAmount: transactions.functionalAmount,
      description: transactions.description,
      merchant: transactions.merchant,
      bookedAt: transactions.bookedAt,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.accountId, expense.accountId),
        eq(transactions.transactionType, "debit"),
        eq(transactions.includeInAnalytics, true),
        isNull(transactions.internalTransferId),
        gte(transactions.bookedAt, fromDate),
        lte(transactions.bookedAt, toDate),
        sql`${transactions.id} NOT IN (SELECT transaction_id FROM planned_expense_transaction_links)`
      )
    )
    .orderBy(desc(transactions.bookedAt))
    .limit(20);

  return rows.map((row) => ({
    id: row.id,
    amount: roundMoney(Math.abs(parseMoney(row.functionalAmount ?? row.amount))),
    description: row.description,
    merchant: row.merchant,
    bookedAt:
      row.bookedAt instanceof Date
        ? row.bookedAt.toISOString().slice(0, 10)
        : String(row.bookedAt).slice(0, 10),
  }));
}

export async function getUpcomingPlannedExpenses(options: {
  days?: 30 | 60 | 90;
  accountIds?: string[];
} = {}): Promise<UpcomingPlannedExpensesData> {
  const userId = await requireAuth();
  const today = dateKey(new Date());
  const maxDays = options.days ?? 90;
  const accountIds = normalizeAccountIds(options.accountIds);

  if (!userId) {
    return {
      currency: "EUR",
      generatedAt: today,
      horizons: [30, 60, 90].map((days) => ({ days: days as 30 | 60 | 90, total: 0, items: [] })),
    };
  }

  const endDate = new Date();
  endDate.setUTCDate(endDate.getUTCDate() + maxDays);
  const endDateKey = dateKey(endDate);

  const [rows, paidByOccurrence, currency] = await Promise.all([
    fetchPlannedExpenseRows(userId, accountIds),
    fetchPaidByOccurrence(userId, today, endDateKey, accountIds),
    getUserCurrency(userId),
  ]);

  const allItems = rows
    .filter((row) => row.isActive)
    .flatMap((row) => {
      const schedule = toScheduleInput(row);
      return generateOccurrences(schedule, today, endDateKey).map((occurrence) => {
        const amountPaid = roundMoney(
          paidByOccurrence.get(`${row.id}:${occurrence.dueDate}`) ?? 0
        );
        return {
          id: `${row.id}:${occurrence.dueDate}`,
          name: row.name,
          categoryName: row.categoryName,
          accountName: row.accountName,
          dueDate: occurrence.dueDate,
          amount: occurrence.amount,
          amountPaid,
          amountRemaining: roundMoney(Math.max(0, occurrence.amount - amountPaid)),
        };
      });
    })
    .filter((item) => item.amountRemaining > 0)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const generatedAtDate = parseDateKey(today);
  const horizons = [30, 60, 90].map((days) => {
    const horizonEnd = new Date(generatedAtDate);
    horizonEnd.setUTCDate(horizonEnd.getUTCDate() + days);
    const horizonEndKey = dateKey(horizonEnd);
    const items = allItems.filter((item) => item.dueDate <= horizonEndKey);
    return {
      days: days as 30 | 60 | 90,
      total: roundMoney(items.reduce((sum, item) => sum + item.amountRemaining, 0)),
      items,
    };
  });

  return {
    currency,
    generatedAt: today,
    horizons,
  };
}
