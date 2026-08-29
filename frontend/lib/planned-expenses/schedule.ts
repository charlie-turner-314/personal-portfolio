export type PlannedExpenseRecurrence =
  | "one_off"
  | "monthly"
  | "quarterly"
  | "annual"
  | "custom";

export interface PlannedExpenseScheduleInput {
  id: string;
  name: string;
  amount: number;
  recurrenceType: PlannedExpenseRecurrence;
  customIntervalMonths: number | null;
  dueDate: string;
  sinkingFundTargetAmount: number;
  sinkingFundStartDate: string;
}

export interface PlannedExpenseOccurrence {
  plannedExpenseId: string;
  name: string;
  dueDate: string;
  amount: number;
}

export function recurrenceIntervalMonths(
  recurrenceType: PlannedExpenseRecurrence,
  customIntervalMonths: number | null = null
): number | null {
  if (recurrenceType === "one_off") return null;
  if (recurrenceType === "monthly") return 1;
  if (recurrenceType === "quarterly") return 3;
  if (recurrenceType === "annual") return 12;

  if (
    customIntervalMonths &&
    Number.isInteger(customIntervalMonths) &&
    customIntervalMonths >= 1 &&
    customIntervalMonths <= 120
  ) {
    return customIntervalMonths;
  }

  return null;
}

export function monthKeyFromDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function parseDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function dateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function addMonthsClamped(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(year, month + months + 1, 0));
  target.setUTCDate(Math.min(day, target.getUTCDate()));
  return target;
}

export function inclusiveMonthCount(startDateKey: string, endDateKey: string): number {
  const start = parseDateKey(startDateKey);
  const end = parseDateKey(endDateKey);
  const diff =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth()) +
    1;
  return Math.max(1, diff);
}

export function calculateMonthlyProvision(
  expense: Pick<
    PlannedExpenseScheduleInput,
    | "recurrenceType"
    | "customIntervalMonths"
    | "dueDate"
    | "sinkingFundTargetAmount"
    | "sinkingFundStartDate"
  >,
  referenceMonthKey: string,
  amountAlreadyApplied = 0
): number {
  const remainingTarget = Math.max(0, expense.sinkingFundTargetAmount - amountAlreadyApplied);

  if (expense.recurrenceType === "one_off") {
    if (referenceMonthKey >= monthKeyFromDate(parseDateKey(expense.dueDate))) {
      return roundMoney(remainingTarget);
    }

    return roundMoney(
      remainingTarget / inclusiveMonthCount(expense.sinkingFundStartDate, expense.dueDate)
    );
  }

  const intervalMonths = recurrenceIntervalMonths(
    expense.recurrenceType,
    expense.customIntervalMonths
  );
  if (!intervalMonths) {
    return 0;
  }

  return roundMoney(expense.sinkingFundTargetAmount / intervalMonths);
}

export function generateOccurrences(
  expense: PlannedExpenseScheduleInput,
  fromDateKey: string,
  toDateKey: string
): PlannedExpenseOccurrence[] {
  const from = parseDateKey(fromDateKey);
  const to = parseDateKey(toDateKey);
  const firstDue = parseDateKey(expense.dueDate);

  if (to < from) return [];

  if (expense.recurrenceType === "one_off") {
    return firstDue >= from && firstDue <= to
      ? [
          {
            plannedExpenseId: expense.id,
            name: expense.name,
            dueDate: expense.dueDate,
            amount: expense.amount,
          },
        ]
      : [];
  }

  const intervalMonths = recurrenceIntervalMonths(
    expense.recurrenceType,
    expense.customIntervalMonths
  );
  if (!intervalMonths) return [];

  const occurrences: PlannedExpenseOccurrence[] = [];
  let cycle = 0;
  let occurrenceDate = firstDue;

  while (occurrenceDate < from && cycle < 1200) {
    cycle += 1;
    occurrenceDate = addMonthsClamped(firstDue, cycle * intervalMonths);
  }

  while (occurrenceDate <= to && cycle < 1200) {
    occurrences.push({
      plannedExpenseId: expense.id,
      name: expense.name,
      dueDate: dateKey(occurrenceDate),
      amount: expense.amount,
    });
    cycle += 1;
    occurrenceDate = addMonthsClamped(firstDue, cycle * intervalMonths);
  }

  return occurrences;
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
