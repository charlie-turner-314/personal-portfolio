export type CashflowDirection = "inflow" | "outflow" | "transfer_in" | "transfer_out";

export type CashflowSourceType =
  | "recurring"
  | "planned_expense"
  | "manual_override"
  | "income_pattern"
  | "transfer";

export type RecurrenceFrequency = "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";

export interface ForecastEntry {
  date: string;
  accountId: string;
  accountName?: string;
  amount: number;
  direction: CashflowDirection;
  spendAmount: number;
  balanceImpact: number;
  sourceType: CashflowSourceType;
  sourceId: string;
  sourceLabel: string;
  traceLabel: string;
}

export interface ForecastEntryInput
  extends Omit<ForecastEntry, "spendAmount" | "balanceImpact"> {
  spendAmount?: number;
  balanceImpact?: number;
}

export interface RecurringForecastInput {
  anchorDate: string;
  fromDate: string;
  toDate: string;
  frequency: RecurrenceFrequency;
  entry: Omit<ForecastEntryInput, "date">;
}

export interface ForecastHorizonSummary {
  days: 30 | 60 | 90;
  startDate: string;
  endDate: string;
  totalInflow: number;
  totalOutflow: number;
  totalSpend: number;
  transferIn: number;
  transferOut: number;
  netBalanceImpact: number;
  entryCount: number;
  entries: ForecastEntry[];
}

export interface StartingBalance {
  accountId: string;
  accountName?: string;
  balance: number;
}

export interface AccountBalanceProjection {
  date: string;
  accountId: string;
  accountName?: string;
  projectedBalance: number;
}

export interface LowBalanceThreshold {
  accountId: string;
  threshold: number;
}

export interface LowBalanceWarning {
  accountId: string;
  accountName?: string;
  date: string;
  projectedBalance: number;
  threshold: number;
}

export interface BuildCashflowForecastInput {
  startDate: string;
  entries: ForecastEntryInput[];
  startingBalances: StartingBalance[];
  lowBalanceThresholds?: LowBalanceThreshold[];
}

export interface CashflowForecast {
  startDate: string;
  endDate: string;
  entries: ForecastEntry[];
  horizons: ForecastHorizonSummary[];
  accountBalanceProjection: AccountBalanceProjection[];
  lowBalanceWarnings: LowBalanceWarning[];
}

const DAY_MS = 86_400_000;
const HORIZONS: Array<30 | 60 | 90> = [30, 60, 90];

export function parseDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function dateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate()
  ).padStart(2, "0")}`;
}

export function addDays(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

export function addMonthsClamped(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(year, month + months + 1, 0));
  target.setUTCDate(Math.min(day, target.getUTCDate()));
  return target;
}

export function compareDateKeys(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function inclusiveDaysBetween(startDate: string, endDate: string): number {
  const start = parseDateKey(startDate);
  const end = parseDateKey(endDate);
  return Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1;
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function createForecastEntry(input: ForecastEntryInput): ForecastEntry {
  const amount = roundMoney(input.amount);

  return {
    ...input,
    amount,
    spendAmount: roundMoney(defaultSpendAmount(input.direction, amount, input.spendAmount)),
    balanceImpact: roundMoney(defaultBalanceImpact(input.direction, amount, input.balanceImpact)),
  };
}

export function generateRecurringDates(
  anchorDate: string,
  fromDate: string,
  toDate: string,
  frequency: RecurrenceFrequency
): string[] {
  if (compareDateKeys(toDate, fromDate) < 0) return [];

  const anchor = parseDateKey(anchorDate);
  const from = parseDateKey(fromDate);
  const to = parseDateKey(toDate);
  const dates: string[] = [];
  let step = 0;
  let occurrence = anchor;

  while (occurrence < from && step < 10_000) {
    step += 1;
    occurrence = addFrequency(anchor, frequency, step);
  }

  while (occurrence <= to && step < 10_000) {
    dates.push(dateKey(occurrence));
    step += 1;
    occurrence = addFrequency(anchor, frequency, step);
  }

  return dates;
}

export function generateRecurringForecastEntries(input: RecurringForecastInput): ForecastEntry[] {
  return generateRecurringDates(
    input.anchorDate,
    input.fromDate,
    input.toDate,
    input.frequency
  ).map((date) => createForecastEntry({ ...input.entry, date }));
}

export function summarizeForecastHorizons(
  entries: ForecastEntryInput[],
  startDate: string,
  horizons: Array<30 | 60 | 90> = HORIZONS
): ForecastHorizonSummary[] {
  const normalizedEntries = normalizeForecastEntries(entries);

  return horizons.map((days) => {
    const endDate = dateKey(addDays(parseDateKey(startDate), days - 1));
    const horizonEntries = normalizedEntries.filter(
      (entry) => entry.date >= startDate && entry.date <= endDate
    );

    return {
      days,
      startDate,
      endDate,
      totalInflow: sumEntries(horizonEntries, "inflow"),
      totalOutflow: sumEntries(horizonEntries, "outflow"),
      totalSpend: roundMoney(horizonEntries.reduce((total, entry) => total + entry.spendAmount, 0)),
      transferIn: sumEntries(horizonEntries, "transfer_in"),
      transferOut: sumEntries(horizonEntries, "transfer_out"),
      netBalanceImpact: roundMoney(
        horizonEntries.reduce((total, entry) => total + entry.balanceImpact, 0)
      ),
      entryCount: horizonEntries.length,
      entries: horizonEntries,
    };
  });
}

export function projectAccountBalances(
  startingBalances: StartingBalance[],
  entries: ForecastEntryInput[],
  startDate: string,
  endDate: string
): AccountBalanceProjection[] {
  const normalizedEntries = normalizeForecastEntries(entries);
  const accounts = collectProjectionAccounts(startingBalances, normalizedEntries);
  const balances = new Map(accounts.map((account) => [account.accountId, account.balance]));
  const entriesByDate = groupEntriesByDate(normalizedEntries);
  const projections: AccountBalanceProjection[] = [];

  for (
    let current = parseDateKey(startDate);
    current <= parseDateKey(endDate);
    current = addDays(current, 1)
  ) {
    const currentDate = dateKey(current);

    for (const entry of entriesByDate.get(currentDate) ?? []) {
      balances.set(
        entry.accountId,
        roundMoney((balances.get(entry.accountId) ?? 0) + entry.balanceImpact)
      );
    }

    for (const account of accounts) {
      projections.push({
        date: currentDate,
        accountId: account.accountId,
        accountName: account.accountName,
        projectedBalance: balances.get(account.accountId) ?? 0,
      });
    }
  }

  return projections;
}

export function findLowBalanceWarnings(
  projections: AccountBalanceProjection[],
  thresholds: LowBalanceThreshold[]
): LowBalanceWarning[] {
  const thresholdByAccount = new Map(
    thresholds.map((threshold) => [threshold.accountId, threshold.threshold])
  );
  const warnedAccounts = new Set<string>();
  const warnings: LowBalanceWarning[] = [];

  for (const projection of [...projections].sort(compareProjections)) {
    const threshold = thresholdByAccount.get(projection.accountId);
    if (threshold === undefined || warnedAccounts.has(projection.accountId)) continue;
    if (projection.projectedBalance >= threshold) continue;

    warnings.push({
      accountId: projection.accountId,
      accountName: projection.accountName,
      date: projection.date,
      projectedBalance: projection.projectedBalance,
      threshold,
    });
    warnedAccounts.add(projection.accountId);
  }

  return warnings;
}

export function buildCashflowForecast(input: BuildCashflowForecastInput): CashflowForecast {
  const startDate = input.startDate;
  const endDate = dateKey(addDays(parseDateKey(startDate), 89));
  const entries = normalizeForecastEntries(input.entries).filter(
    (entry) => entry.date >= startDate && entry.date <= endDate
  );
  const horizons = summarizeForecastHorizons(entries, startDate);
  const accountBalanceProjection = projectAccountBalances(
    input.startingBalances,
    entries,
    startDate,
    endDate
  );

  return {
    startDate,
    endDate,
    entries,
    horizons,
    accountBalanceProjection,
    lowBalanceWarnings: findLowBalanceWarnings(
      accountBalanceProjection,
      input.lowBalanceThresholds ?? []
    ),
  };
}

function addFrequency(anchor: Date, frequency: RecurrenceFrequency, step: number): Date {
  if (frequency === "weekly") return addDays(anchor, step * 7);
  if (frequency === "biweekly") return addDays(anchor, step * 14);
  if (frequency === "monthly") return addMonthsClamped(anchor, step);
  if (frequency === "quarterly") return addMonthsClamped(anchor, step * 3);
  return addMonthsClamped(anchor, step * 12);
}

function normalizeForecastEntries(entries: ForecastEntryInput[]): ForecastEntry[] {
  return entries
    .map(createForecastEntry)
    .sort(
      (left, right) =>
        compareDateKeys(left.date, right.date) || left.sourceId.localeCompare(right.sourceId)
    );
}

function collectProjectionAccounts(
  startingBalances: StartingBalance[],
  entries: ForecastEntry[]
): Array<StartingBalance & { balance: number }> {
  const accounts = new Map<string, StartingBalance & { balance: number }>();

  for (const account of startingBalances) {
    accounts.set(account.accountId, {
      ...account,
      balance: roundMoney(account.balance),
    });
  }

  for (const entry of entries) {
    if (accounts.has(entry.accountId)) continue;
    accounts.set(entry.accountId, {
      accountId: entry.accountId,
      accountName: entry.accountName,
      balance: 0,
    });
  }

  return [...accounts.values()].sort((left, right) => left.accountId.localeCompare(right.accountId));
}

function defaultSpendAmount(
  direction: CashflowDirection,
  amount: number,
  explicitSpendAmount?: number
): number {
  if (direction === "transfer_in" || direction === "transfer_out") return 0;
  if (explicitSpendAmount !== undefined) return explicitSpendAmount;
  return direction === "outflow" ? Math.abs(amount) : 0;
}

function defaultBalanceImpact(
  direction: CashflowDirection,
  amount: number,
  explicitBalanceImpact?: number
): number {
  if (explicitBalanceImpact !== undefined) return explicitBalanceImpact;

  if (direction === "inflow" || direction === "transfer_in") return Math.abs(amount);
  return -Math.abs(amount);
}

function sumEntries(entries: ForecastEntry[], direction: CashflowDirection): number {
  return roundMoney(
    entries
      .filter((entry) => entry.direction === direction)
      .reduce((total, entry) => total + Math.abs(entry.amount), 0)
  );
}

function groupEntriesByDate(entries: ForecastEntry[]): Map<string, ForecastEntry[]> {
  const grouped = new Map<string, ForecastEntry[]>();

  for (const entry of entries) {
    const bucket = grouped.get(entry.date) ?? [];
    bucket.push(entry);
    grouped.set(entry.date, bucket);
  }

  return grouped;
}

function compareProjections(
  left: AccountBalanceProjection,
  right: AccountBalanceProjection
): number {
  return compareDateKeys(left.date, right.date) || left.accountId.localeCompare(right.accountId);
}
