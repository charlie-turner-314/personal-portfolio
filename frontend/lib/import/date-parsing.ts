export type ImportedDateFormat = "DD-MM-YYYY" | "MM-DD-YYYY";

/**
 * Parses the date portion of a transaction export without relying on the
 * runtime's locale-dependent `Date` parser. A time may appear before or after
 * the date; only the date token determines the returned calendar day.
 */
export function parseImportedDate(
  raw: string | null | undefined,
  dateFormat: ImportedDateFormat = "DD-MM-YYYY",
): Date | null {
  const value = raw?.replace(/["']/g, "").trim();
  if (!value) return null;

  const compact = value.match(/^\d{8}$/);
  if (compact) {
    return createValidatedUtcDate(
      Number(compact[0].slice(0, 4)),
      Number(compact[0].slice(4, 6)),
      Number(compact[0].slice(6, 8)),
    );
  }

  const iso = value.match(/(?:^|\s)(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\b|T)/);
  if (iso) return createValidatedUtcDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const numeric = value.match(/(?:^|\s)(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\b|\s|$)/);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const year = normalizeYear(Number(numeric[3]), numeric[3].length);
    if (year === null) return null;

    const dayFirst = first > 12 || (second <= 12 && dateFormat === "DD-MM-YYYY");
    return dayFirst
      ? createValidatedUtcDate(year, second, first)
      : createValidatedUtcDate(year, first, second);
  }

  const monthFirst = value.match(/(?:^|\s)([a-z]+)\s+(\d{1,2}),?\s+(\d{4})(?:\b|$)/i);
  if (monthFirst) {
    return createValidatedUtcDate(Number(monthFirst[3]), monthNumber(monthFirst[1]), Number(monthFirst[2]));
  }

  const dayFirst = value.match(/(?:^|\s)(\d{1,2})\s+([a-z]+)\s+(\d{4})(?:\b|$)/i);
  if (dayFirst) {
    return createValidatedUtcDate(Number(dayFirst[3]), monthNumber(dayFirst[2]), Number(dayFirst[1]));
  }

  return null;
}

function normalizeYear(year: number, digits: number): number | null {
  if (digits === 4) return year >= 1900 ? year : null;
  return year <= 50 ? 2000 + year : 1900 + year;
}

function monthNumber(value: string): number {
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const month = months.findIndex((name) => name === value.toLowerCase() || name.slice(0, 3) === value.toLowerCase());
  return month + 1;
}

function createValidatedUtcDate(year: number, month: number, day: number): Date | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const result = new Date(Date.UTC(year, month - 1, day));
  return result.getUTCFullYear() === year && result.getUTCMonth() === month - 1 && result.getUTCDate() === day ? result : null;
}
