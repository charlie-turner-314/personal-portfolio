"use server";

import { revalidatePath } from "next/cache";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { requireAuth } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import {
  accounts,
  cashflowOverrides,
  categories,
  plannedExpenseTransactionLinks,
  plannedExpenses,
  recurringTransactionScheduleOverrides,
  recurringTransactions,
  transactions,
  users,
} from "@/lib/db/schema";
import {
  buildCashflowForecast,
  dateKey,
  generateRecurringForecastEntries,
  parseDateKey,
  roundMoney,
  type CashflowDirection,
  type CashflowForecast,
  type ForecastEntryInput,
  type RecurrenceFrequency,
  type StartingBalance,
} from "@/lib/cashflow/forecast";
import {
  generateOccurrences,
  type PlannedExpenseRecurrence,
  type PlannedExpenseScheduleInput,
} from "@/lib/planned-expenses/schedule";

export type CashflowOverrideDirection =
  | "income"
  | "expense"
  | "transfer_in"
  | "transfer_out";

export interface CashflowForecastOptions {
  accountIds?: string[];
  warningThreshold?: number;
}

export interface CashflowOverrideInput {
  accountId: string;
  categoryId?: string | null;
  expectedDate: string;
  direction: CashflowOverrideDirection;
  amount: number;
  description: string;
  notes?: string | null;
}

export interface CashflowActionResult {
  success: boolean;
  error?: string;
  id?: string;
}

export interface CashflowForecastFormOptions {
  accounts: { id: string; name: string }[];
  categories: { id: string; name: string; categoryType: string | null }[];
}

export interface CashflowOverrideListItem {
  id: string;
  accountId: string;
  accountName: string;
  categoryId: string | null;
  categoryName: string | null;
  expectedDate: string;
  direction: CashflowOverrideDirection;
  amount: number;
  description: string;
  notes: string | null;
}

export interface CashflowForecastData extends CashflowForecast {
  currency: string;
  generatedAt: string;
  accountIds: string[];
  overrides: CashflowOverrideListItem[];
  summary: {
    startingBalance: number;
    projectedEndingBalance: number;
    inflows: number;
    outflows: number;
    transfers: number;
    netBalanceImpact: number;
  };
}

const VALID_OVERRIDE_DIRECTIONS: CashflowOverrideDirection[] = [
  "income",
  "expense",
  "transfer_in",
  "transfer_out",
];

function parseMoney(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeAccountIds(accountIds?: string[]): string[] {
  if (!accountIds?.length) return [];
  return Array.from(new Set(accountIds.map((id) => id.trim()).filter(Boolean)));
}

function normalizeDateKey(value?: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = parseDateKey(value);
  return Number.isNaN(parsed.getTime()) ? null : value;
}

function addDays(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

function toForecastDirection(direction: CashflowOverrideDirection): CashflowDirection {
  if (direction === "income") return "inflow";
  if (direction === "expense") return "outflow";
  return direction;
}

function recurrenceFrequency(value: string): RecurrenceFrequency | null {
  if (
    value === "weekly" ||
    value === "biweekly" ||
    value === "monthly" ||
    value === "quarterly" ||
    value === "yearly"
  ) {
    return value;
  }
  return null;
}

function recurringDirection(
  categoryType: string | null,
  overrideDirection: string | null,
  recentCredits: number,
  recentDebits: number
): CashflowDirection {
  if (overrideDirection === "inflow") return "inflow";
  if (overrideDirection === "outflow") return "outflow";
  if (categoryType === "income") return "inflow";
  if (categoryType === "transfer") {
    return recentCredits > recentDebits ? "transfer_in" : "transfer_out";
  }
  if (!categoryType && recentCredits > recentDebits) return "inflow";
  return "outflow";
}

async function getUserCurrency(userId: string): Promise<string> {
  const rows = await db
    .select({ functionalCurrency: users.functionalCurrency })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return rows[0]?.functionalCurrency || "EUR";
}

async function getForecastAccounts(userId: string, accountIds: string[]) {
  const conditions = [eq(accounts.userId, userId), eq(accounts.isActive, true)];
  if (accountIds.length) conditions.push(inArray(accounts.id, accountIds));

  return db
    .select({
      id: accounts.id,
      name: accounts.name,
      functionalBalance: accounts.functionalBalance,
      balanceAvailable: accounts.balanceAvailable,
      startingBalance: accounts.startingBalance,
    })
    .from(accounts)
    .where(and(...conditions))
    .orderBy(asc(accounts.name));
}

function accountStartingBalances(
  accountRows: Awaited<ReturnType<typeof getForecastAccounts>>
): StartingBalance[] {
  return accountRows.map((account) => ({
    accountId: account.id,
    accountName: account.name,
    balance: parseMoney(
      account.functionalBalance ?? account.balanceAvailable ?? account.startingBalance
    ),
  }));
}

async function getManualOverrideEntries(
  userId: string,
  fromDate: string,
  toDate: string,
  accountIds: string[]
): Promise<{
  entries: ForecastEntryInput[];
  overrides: CashflowOverrideListItem[];
}> {
  const conditions = [
    eq(cashflowOverrides.userId, userId),
    eq(cashflowOverrides.isActive, true),
    gte(cashflowOverrides.expectedDate, fromDate),
    lte(cashflowOverrides.expectedDate, toDate),
  ];
  if (accountIds.length) conditions.push(inArray(cashflowOverrides.accountId, accountIds));

  const rows = await db
    .select({
      id: cashflowOverrides.id,
      accountId: cashflowOverrides.accountId,
      accountName: accounts.name,
      categoryId: cashflowOverrides.categoryId,
      categoryName: categories.name,
      expectedDate: cashflowOverrides.expectedDate,
      direction: cashflowOverrides.direction,
      amount: cashflowOverrides.amount,
      description: cashflowOverrides.description,
      notes: cashflowOverrides.notes,
    })
    .from(cashflowOverrides)
    .innerJoin(accounts, eq(cashflowOverrides.accountId, accounts.id))
    .leftJoin(categories, eq(cashflowOverrides.categoryId, categories.id))
    .where(and(...conditions))
    .orderBy(asc(cashflowOverrides.expectedDate), asc(cashflowOverrides.description));

  const overrides = rows.map((row) => ({
    id: row.id,
    accountId: row.accountId,
    accountName: row.accountName,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    expectedDate: row.expectedDate,
    direction: row.direction as CashflowOverrideDirection,
    amount: parseMoney(row.amount),
    description: row.description,
    notes: row.notes,
  }));

  return {
    overrides,
    entries: overrides.map((override) => ({
      date: override.expectedDate,
      accountId: override.accountId,
      accountName: override.accountName,
      amount: override.amount,
      direction: toForecastDirection(override.direction),
      sourceType: "manual_override",
      sourceId: override.id,
      sourceLabel: override.description,
      traceLabel: `Manual override: ${override.description}`,
    })),
  };
}

async function getPlannedExpenseEntries(
  userId: string,
  fromDate: string,
  toDate: string,
  accountIds: string[]
): Promise<ForecastEntryInput[]> {
  const conditions = [
    eq(plannedExpenses.userId, userId),
    eq(plannedExpenses.isActive, true),
  ];
  if (accountIds.length) conditions.push(inArray(plannedExpenses.accountId, accountIds));

  const [expenseRows, paidRows] = await Promise.all([
    db
      .select({
        id: plannedExpenses.id,
        name: plannedExpenses.name,
        amount: plannedExpenses.amount,
        accountId: plannedExpenses.accountId,
        accountName: accounts.name,
        dueDate: plannedExpenses.dueDate,
        recurrenceType: plannedExpenses.recurrenceType,
        customIntervalMonths: plannedExpenses.customIntervalMonths,
        sinkingFundTargetAmount: plannedExpenses.sinkingFundTargetAmount,
        sinkingFundStartDate: plannedExpenses.sinkingFundStartDate,
      })
      .from(plannedExpenses)
      .innerJoin(accounts, eq(plannedExpenses.accountId, accounts.id))
      .where(and(...conditions)),
    db
      .select({
        plannedExpenseId: plannedExpenseTransactionLinks.plannedExpenseId,
        occurrenceDueDate: plannedExpenseTransactionLinks.occurrenceDueDate,
        amount: sql<string>`COALESCE(SUM(${plannedExpenseTransactionLinks.amountApplied}), 0)`,
      })
      .from(plannedExpenseTransactionLinks)
      .innerJoin(
        plannedExpenses,
        eq(plannedExpenseTransactionLinks.plannedExpenseId, plannedExpenses.id)
      )
      .where(
        and(
          eq(plannedExpenseTransactionLinks.userId, userId),
          gte(plannedExpenseTransactionLinks.occurrenceDueDate, fromDate),
          lte(plannedExpenseTransactionLinks.occurrenceDueDate, toDate),
          ...(accountIds.length ? [inArray(plannedExpenses.accountId, accountIds)] : [])
        )
      )
      .groupBy(
        plannedExpenseTransactionLinks.plannedExpenseId,
        plannedExpenseTransactionLinks.occurrenceDueDate
      ),
  ]);

  const paidByOccurrence = new Map(
    paidRows.map((row) => [
      `${row.plannedExpenseId}:${row.occurrenceDueDate}`,
      parseMoney(row.amount),
    ])
  );

  return expenseRows.flatMap((row) => {
    const schedule: PlannedExpenseScheduleInput = {
      id: row.id,
      name: row.name,
      amount: parseMoney(row.amount),
      recurrenceType: row.recurrenceType as PlannedExpenseRecurrence,
      customIntervalMonths: row.customIntervalMonths,
      dueDate: row.dueDate,
      sinkingFundTargetAmount: parseMoney(row.sinkingFundTargetAmount),
      sinkingFundStartDate: row.sinkingFundStartDate,
    };

    return generateOccurrences(schedule, fromDate, toDate)
      .map((occurrence) => {
        const paid = paidByOccurrence.get(`${row.id}:${occurrence.dueDate}`) ?? 0;
        const remaining = roundMoney(Math.max(0, occurrence.amount - paid));
        return {
          date: occurrence.dueDate,
          accountId: row.accountId,
          accountName: row.accountName,
          amount: remaining,
          direction: "outflow" as const,
          sourceType: "planned_expense" as const,
          sourceId: row.id,
          sourceLabel: row.name,
          traceLabel: `Planned expense: ${row.name}`,
        };
      })
      .filter((entry) => entry.amount > 0);
  });
}

async function getRecurringEntries(
  userId: string,
  fromDate: string,
  toDate: string,
  accountIds: string[]
): Promise<ForecastEntryInput[]> {
  const conditions = [
    eq(recurringTransactions.userId, userId),
    eq(recurringTransactions.isActive, true),
  ];
  if (accountIds.length) conditions.push(inArray(recurringTransactions.accountId, accountIds));

  const [rows, latestRows, countRows] = await Promise.all([
    db
      .select({
        id: recurringTransactions.id,
        name: recurringTransactions.name,
        amount: recurringTransactions.amount,
        frequency: recurringTransactions.frequency,
        accountId: recurringTransactions.accountId,
        accountName: accounts.name,
        categoryType: categories.categoryType,
        createdAt: recurringTransactions.createdAt,
        anchorDate: recurringTransactionScheduleOverrides.anchorDate,
        overrideDirection: recurringTransactionScheduleOverrides.direction,
      })
      .from(recurringTransactions)
      .leftJoin(accounts, eq(recurringTransactions.accountId, accounts.id))
      .leftJoin(categories, eq(recurringTransactions.categoryId, categories.id))
      .leftJoin(
        recurringTransactionScheduleOverrides,
        eq(
          recurringTransactions.id,
          recurringTransactionScheduleOverrides.recurringTransactionId
        )
      )
      .where(and(...conditions)),
    db
      .select({
        recurringTransactionId: transactions.recurringTransactionId,
        latestDate: sql<string>`MAX(${transactions.bookedAt})`,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          isNotNull(transactions.recurringTransactionId),
          ...(accountIds.length ? [inArray(transactions.accountId, accountIds)] : [])
        )
      )
      .groupBy(transactions.recurringTransactionId),
    db
      .select({
        recurringTransactionId: transactions.recurringTransactionId,
        credits: sql<string>`COUNT(*) FILTER (WHERE ${transactions.transactionType} = 'credit')`,
        debits: sql<string>`COUNT(*) FILTER (WHERE ${transactions.transactionType} = 'debit')`,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          isNotNull(transactions.recurringTransactionId),
          ...(accountIds.length ? [inArray(transactions.accountId, accountIds)] : [])
        )
      )
      .groupBy(transactions.recurringTransactionId),
  ]);

  const latestByRecurring = new Map(
    latestRows.map((row) => [
      row.recurringTransactionId,
      row.latestDate ? dateKey(new Date(row.latestDate)) : null,
    ])
  );
  const countsByRecurring = new Map(
    countRows.map((row) => [
      row.recurringTransactionId,
      { credits: parseMoney(row.credits), debits: parseMoney(row.debits) },
    ])
  );

  return rows.flatMap((row) => {
    if (!row.accountId || !row.accountName) return [];
    const frequency = recurrenceFrequency(row.frequency);
    if (!frequency) return [];

    const counts = countsByRecurring.get(row.id) ?? { credits: 0, debits: 0 };
    const direction = recurringDirection(
      row.categoryType,
      row.overrideDirection,
      counts.credits,
      counts.debits
    );
    const createdDate =
      row.createdAt instanceof Date
        ? dateKey(row.createdAt)
        : dateKey(new Date(row.createdAt ?? Date.now()));
    const anchorDate = row.anchorDate ?? latestByRecurring.get(row.id) ?? createdDate;

    return generateRecurringForecastEntries({
      anchorDate,
      fromDate,
      toDate,
      frequency,
      entry: {
        accountId: row.accountId,
        accountName: row.accountName,
        amount: Math.abs(parseMoney(row.amount)),
        direction,
        sourceType:
          direction === "transfer_in" || direction === "transfer_out" ? "transfer" : "recurring",
        sourceId: row.id,
        sourceLabel: row.name,
        traceLabel: `Recurring ${row.frequency}: ${row.name}`,
      },
    });
  });
}

async function getIncomePatternEntries(
  userId: string,
  fromDate: string,
  toDate: string,
  accountIds: string[]
): Promise<ForecastEntryInput[]> {
  const start = parseDateKey(fromDate);
  const historyStart = addDays(start, -120);
  const rows = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      accountName: accounts.name,
      categoryId: categories.id,
      categoryName: categories.name,
      merchant: transactions.merchant,
      description: transactions.description,
      amount: transactions.amount,
      functionalAmount: transactions.functionalAmount,
      bookedAt: transactions.bookedAt,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .innerJoin(
      categories,
      sql`${categories.id} = COALESCE(${transactions.categoryId}, ${transactions.categorySystemId})`
    )
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.transactionType, "credit"),
        eq(transactions.includeInAnalytics, true),
        isNull(transactions.internalTransferId),
        isNull(transactions.recurringTransactionId),
        eq(categories.categoryType, "income"),
        gte(transactions.bookedAt, historyStart),
        lte(transactions.bookedAt, start),
        ...(accountIds.length ? [inArray(transactions.accountId, accountIds)] : [])
      )
    )
    .orderBy(asc(transactions.bookedAt));

  const groups = new Map<
    string,
    {
      accountId: string;
      accountName: string;
      categoryName: string;
      label: string;
      amounts: number[];
      dates: string[];
    }
  >();

  for (const row of rows) {
    const label = (row.merchant || row.description || row.categoryName || "Income").trim();
    const key = `${row.accountId}:${row.categoryId}:${label.toLowerCase()}`;
    const group =
      groups.get(key) ??
      {
        accountId: row.accountId,
        accountName: row.accountName,
        categoryName: row.categoryName,
        label,
        amounts: [],
        dates: [],
      };
    group.amounts.push(Math.abs(parseMoney(row.functionalAmount ?? row.amount)));
    group.dates.push(row.bookedAt instanceof Date ? dateKey(row.bookedAt) : dateKey(new Date(row.bookedAt)));
    groups.set(key, group);
  }

  return Array.from(groups.entries()).flatMap(([key, group]) => {
    const uniqueDates = Array.from(new Set(group.dates)).sort();
    if (uniqueDates.length < 2) return [];

    const intervalDays = estimateIntervalDays(uniqueDates);
    if (!intervalDays) return [];

    const amount = roundMoney(
      group.amounts.reduce((sum, value) => sum + value, 0) / group.amounts.length
    );
    const entries: ForecastEntryInput[] = [];
    let nextDate = addDays(parseDateKey(uniqueDates[uniqueDates.length - 1]), intervalDays);

    while (dateKey(nextDate) < fromDate) {
      nextDate = addDays(nextDate, intervalDays);
    }

    while (dateKey(nextDate) <= toDate) {
      entries.push({
        date: dateKey(nextDate),
        accountId: group.accountId,
        accountName: group.accountName,
        amount,
        direction: "inflow",
        sourceType: "income_pattern",
        sourceId: key,
        sourceLabel: group.label,
        traceLabel: `Income pattern: ${group.label}`,
      });
      nextDate = addDays(nextDate, intervalDays);
    }

    return entries;
  });
}

function estimateIntervalDays(sortedDateKeys: string[]): number | null {
  const gaps = sortedDateKeys
    .slice(1)
    .map((date, index) => {
      const previous = parseDateKey(sortedDateKeys[index]);
      const current = parseDateKey(date);
      return Math.round((current.getTime() - previous.getTime()) / 86_400_000);
    })
    .filter((gap) => gap >= 5);

  if (gaps.length === 0) return null;
  const sorted = [...gaps].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export async function getCashflowForecast(
  options: CashflowForecastOptions = {}
): Promise<CashflowForecastData> {
  const userId = await requireAuth();
  const generatedAt = dateKey(new Date());
  const accountIds = normalizeAccountIds(options.accountIds);
  const warningThreshold = Number.isFinite(options.warningThreshold)
    ? Number(options.warningThreshold)
    : 0;

  if (!userId) {
    const emptyForecast = buildCashflowForecast({
      startDate: generatedAt,
      entries: [],
      startingBalances: [],
      lowBalanceThresholds: [],
    });
    return {
      ...emptyForecast,
      currency: "EUR",
      generatedAt,
      accountIds,
      overrides: [],
      summary: {
        startingBalance: 0,
        projectedEndingBalance: 0,
        inflows: 0,
        outflows: 0,
        transfers: 0,
        netBalanceImpact: 0,
      },
    };
  }

  const toDate = dateKey(addDays(parseDateKey(generatedAt), 89));
  const [accountRows, manual, planned, recurring, incomePatterns, currency] =
    await Promise.all([
      getForecastAccounts(userId, accountIds),
      getManualOverrideEntries(userId, generatedAt, toDate, accountIds),
      getPlannedExpenseEntries(userId, generatedAt, toDate, accountIds),
      getRecurringEntries(userId, generatedAt, toDate, accountIds),
      getIncomePatternEntries(userId, generatedAt, toDate, accountIds),
      getUserCurrency(userId),
    ]);

  const startingBalances = accountStartingBalances(accountRows);
  const forecast = buildCashflowForecast({
    startDate: generatedAt,
    entries: [...manual.entries, ...planned, ...recurring, ...incomePatterns],
    startingBalances,
    lowBalanceThresholds: startingBalances.map((account) => ({
      accountId: account.accountId,
      threshold: warningThreshold,
    })),
  });
  const horizon90 = forecast.horizons.find((horizon) => horizon.days === 90);
  const startingBalance = roundMoney(
    startingBalances.reduce((sum, account) => sum + account.balance, 0)
  );
  const netBalanceImpact = horizon90?.netBalanceImpact ?? 0;

  return {
    ...forecast,
    currency,
    generatedAt,
    accountIds,
    overrides: manual.overrides,
    summary: {
      startingBalance,
      projectedEndingBalance: roundMoney(startingBalance + netBalanceImpact),
      inflows: horizon90?.totalInflow ?? 0,
      outflows: horizon90?.totalOutflow ?? 0,
      transfers: roundMoney((horizon90?.transferIn ?? 0) + (horizon90?.transferOut ?? 0)),
      netBalanceImpact,
    },
  };
}

export async function getCashflowOverrideFormOptions(): Promise<CashflowForecastFormOptions> {
  const userId = await requireAuth();
  if (!userId) return { accounts: [], categories: [] };

  const [accountRows, categoryRows] = await Promise.all([
    db
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.isActive, true)))
      .orderBy(asc(accounts.name)),
    db
      .select({
        id: categories.id,
        name: categories.name,
        categoryType: categories.categoryType,
      })
      .from(categories)
      .where(
        and(
          eq(categories.userId, userId),
          or(eq(categories.hideFromSelection, false), isNull(categories.hideFromSelection))
        )
      )
      .orderBy(asc(categories.categoryType), asc(categories.name)),
  ]);

  return {
    accounts: accountRows,
    categories: categoryRows,
  };
}

function normalizeOverrideInput(input: CashflowOverrideInput):
  | (CashflowOverrideInput & { expectedDate: string; amount: number; description: string })
  | { error: string } {
  const expectedDate = normalizeDateKey(input.expectedDate);
  const amount = roundMoney(parseMoney(input.amount));
  const description = input.description.trim();

  if (!input.accountId) return { error: "Account is required" };
  if (!expectedDate) return { error: "Expected date is required" };
  if (!VALID_OVERRIDE_DIRECTIONS.includes(input.direction)) {
    return { error: "Unsupported cashflow direction" };
  }
  if (amount <= 0) return { error: "Amount must be greater than zero" };
  if (!description) return { error: "Description is required" };

  return {
    ...input,
    expectedDate,
    amount,
    description,
    categoryId: input.categoryId || null,
    notes: input.notes?.trim() || null,
  };
}

async function validateOverrideOwnership(
  userId: string,
  input: Pick<CashflowOverrideInput, "accountId" | "categoryId">
): Promise<string | null> {
  const accountRows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, input.accountId), eq(accounts.userId, userId)))
    .limit(1);

  if (!accountRows[0]) return "Account could not be found";

  if (input.categoryId) {
    const categoryRows = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, input.categoryId), eq(categories.userId, userId)))
      .limit(1);
    if (!categoryRows[0]) return "Category could not be found";
  }

  return null;
}

export async function createCashflowOverride(
  input: CashflowOverrideInput
): Promise<CashflowActionResult> {
  const userId = await requireAuth();
  if (!userId) return { success: false, error: "Not authenticated" };

  const normalized = normalizeOverrideInput(input);
  if ("error" in normalized) return { success: false, error: normalized.error };

  const ownershipError = await validateOverrideOwnership(userId, normalized);
  if (ownershipError) return { success: false, error: ownershipError };

  try {
    const [inserted] = await db
      .insert(cashflowOverrides)
      .values({
        userId,
        accountId: normalized.accountId,
        categoryId: normalized.categoryId,
        expectedDate: normalized.expectedDate,
        direction: normalized.direction,
        amount: normalized.amount.toFixed(2),
        description: normalized.description,
        notes: normalized.notes,
        updatedAt: new Date(),
      })
      .returning({ id: cashflowOverrides.id });

    revalidatePath("/cashflow");
    revalidatePath("/");
    return { success: true, id: inserted.id };
  } catch (error) {
    console.error("Failed to create cashflow override:", error);
    return { success: false, error: "Failed to create cashflow override" };
  }
}

export async function updateCashflowOverride(
  id: string,
  input: CashflowOverrideInput
): Promise<CashflowActionResult> {
  const userId = await requireAuth();
  if (!userId) return { success: false, error: "Not authenticated" };

  const normalized = normalizeOverrideInput(input);
  if ("error" in normalized) return { success: false, error: normalized.error };

  const ownershipError = await validateOverrideOwnership(userId, normalized);
  if (ownershipError) return { success: false, error: ownershipError };

  try {
    const [updated] = await db
      .update(cashflowOverrides)
      .set({
        accountId: normalized.accountId,
        categoryId: normalized.categoryId,
        expectedDate: normalized.expectedDate,
        direction: normalized.direction,
        amount: normalized.amount.toFixed(2),
        description: normalized.description,
        notes: normalized.notes,
        updatedAt: new Date(),
      })
      .where(and(eq(cashflowOverrides.id, id), eq(cashflowOverrides.userId, userId)))
      .returning({ id: cashflowOverrides.id });

    if (!updated) return { success: false, error: "Cashflow override not found" };

    revalidatePath("/cashflow");
    revalidatePath("/");
    return { success: true, id };
  } catch (error) {
    console.error("Failed to update cashflow override:", error);
    return { success: false, error: "Failed to update cashflow override" };
  }
}

export async function deleteCashflowOverride(id: string): Promise<CashflowActionResult> {
  const userId = await requireAuth();
  if (!userId) return { success: false, error: "Not authenticated" };

  try {
    const [deleted] = await db
      .delete(cashflowOverrides)
      .where(and(eq(cashflowOverrides.id, id), eq(cashflowOverrides.userId, userId)))
      .returning({ id: cashflowOverrides.id });

    if (!deleted) return { success: false, error: "Cashflow override not found" };

    revalidatePath("/cashflow");
    revalidatePath("/");
    return { success: true };
  } catch (error) {
    console.error("Failed to delete cashflow override:", error);
    return { success: false, error: "Failed to delete cashflow override" };
  }
}

export async function setRecurringScheduleOverride(input: {
  recurringTransactionId: string;
  anchorDate: string;
  direction: "inflow" | "outflow";
}): Promise<CashflowActionResult> {
  const userId = await requireAuth();
  if (!userId) return { success: false, error: "Not authenticated" };

  const anchorDate = normalizeDateKey(input.anchorDate);
  if (!anchorDate) return { success: false, error: "Anchor date is required" };
  if (input.direction !== "inflow" && input.direction !== "outflow") {
    return { success: false, error: "Unsupported recurring direction" };
  }

  const recurringRows = await db
    .select({ id: recurringTransactions.id })
    .from(recurringTransactions)
    .where(
      and(
        eq(recurringTransactions.id, input.recurringTransactionId),
        eq(recurringTransactions.userId, userId)
      )
    )
    .limit(1);
  if (!recurringRows[0]) return { success: false, error: "Recurring item not found" };

  try {
    const [row] = await db
      .insert(recurringTransactionScheduleOverrides)
      .values({
        userId,
        recurringTransactionId: input.recurringTransactionId,
        anchorDate,
        direction: input.direction,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: recurringTransactionScheduleOverrides.recurringTransactionId,
        set: {
          anchorDate,
          direction: input.direction,
          updatedAt: new Date(),
        },
      })
      .returning({ id: recurringTransactionScheduleOverrides.id });

    revalidatePath("/cashflow");
    revalidatePath("/");
    return { success: true, id: row.id };
  } catch (error) {
    console.error("Failed to save recurring schedule override:", error);
    return { success: false, error: "Failed to save recurring schedule override" };
  }
}
