export interface AustralianFinancialYearRange {
  startYear: number;
  label: string;
  startDate: string;
  endDate: string;
}

export interface AustralianFinancialYearDateRange extends AustralianFinancialYearRange {
  from: Date;
  to: Date;
}

const AUSTRALIAN_FINANCIAL_YEAR_TIME_ZONE = "Australia/Sydney";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function localDateKey(date: Date): string {
  return isoDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function assertValidStartYear(startYear: number): number {
  if (!Number.isInteger(startYear) || startYear < 1900 || startYear > 9998) {
    throw new Error("Australian financial-year start year must be an integer from 1900 to 9998");
  }
  return startYear;
}

function getAustralianCalendarYearAndMonth(referenceDate: Date): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: AUSTRALIAN_FINANCIAL_YEAR_TIME_ZONE,
    year: "numeric",
    month: "numeric",
  }).formatToParts(referenceDate);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value) - 1;

  return { year, month };
}

export function formatAustralianFinancialYearLabel(startYear: number): string {
  const normalizedStartYear = assertValidStartYear(startYear);
  return `FY${normalizedStartYear}-${String(normalizedStartYear + 1).slice(-2)}`;
}

export function getAustralianFinancialYearStartYear(referenceDate: Date = new Date()): number {
  const { year, month } = getAustralianCalendarYearAndMonth(referenceDate);
  return month >= 6 ? year : year - 1;
}

export function getAustralianFinancialYearRange(startYear: number): AustralianFinancialYearRange {
  const normalizedStartYear = assertValidStartYear(startYear);
  return {
    startYear: normalizedStartYear,
    label: formatAustralianFinancialYearLabel(normalizedStartYear),
    startDate: isoDate(normalizedStartYear, 7, 1),
    endDate: isoDate(normalizedStartYear + 1, 6, 30),
  };
}

export function getAustralianFinancialYearForDate(
  referenceDate: Date = new Date(),
): AustralianFinancialYearRange {
  return getAustralianFinancialYearRange(
    getAustralianFinancialYearStartYear(referenceDate),
  );
}

export function getPreviousAustralianFinancialYearForDate(
  referenceDate: Date = new Date(),
): AustralianFinancialYearRange {
  return getAustralianFinancialYearRange(
    getAustralianFinancialYearStartYear(referenceDate) - 1,
  );
}

export function getAustralianFinancialYearUtcInterval(startYear: number): {
  start: Date;
  end: Date;
} {
  const normalizedStartYear = assertValidStartYear(startYear);
  return {
    start: new Date(Date.UTC(normalizedStartYear, 6, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(normalizedStartYear + 1, 5, 30, 23, 59, 59, 999)),
  };
}

export function getAustralianFinancialYearLocalDateRange(
  startYear: number,
): AustralianFinancialYearDateRange {
  const range = getAustralianFinancialYearRange(startYear);
  return {
    ...range,
    from: new Date(range.startYear, 6, 1),
    to: new Date(range.startYear + 1, 5, 30),
  };
}

export function getAustralianFinancialYearPresetDateRanges(
  referenceDate: Date = new Date(),
): Array<{ label: string; range: AustralianFinancialYearDateRange }> {
  const currentStartYear = getAustralianFinancialYearStartYear(referenceDate);
  const current = getAustralianFinancialYearLocalDateRange(currentStartYear);
  const previous = getAustralianFinancialYearLocalDateRange(currentStartYear - 1);

  return [
    { label: `This FY (${current.label})`, range: current },
    { label: `Last FY (${previous.label})`, range: previous },
  ];
}

export function getAustralianFinancialYearLabelForDateRange(
  from: Date | undefined,
  to: Date | undefined,
): string | null {
  if (!from || !to) return null;

  const startYear = from.getMonth() === 6 && from.getDate() === 1
    ? from.getFullYear()
    : null;
  if (startYear === null) return null;

  const expectedRange = getAustralianFinancialYearRange(startYear);
  if (
    localDateKey(from) !== expectedRange.startDate ||
    localDateKey(to) !== expectedRange.endDate
  ) {
    return null;
  }

  return expectedRange.label;
}
