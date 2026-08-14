import {
  inferAmountFormat,
  parseLocalizedNumber,
  type AmountFormat,
} from "@/lib/import/parsing";

export type InvestmentIncomeEventType = "dividend" | "distribution";

export interface InvestmentIncomeColumnMapping {
  eventType: string | null;
  payDate: string | null;
  exDate: string | null;
  cashReceived: string | null;
  frankedAmount: string | null;
  unfrankedAmount: string | null;
  frankingCredit: string | null;
  foreignIncome: string | null;
  foreignTaxPaid: string | null;
  drp: string | null;
  drpQuantity?: string | null;
  drpPrice?: string | null;
  amitAmmaComponents: string | null;
  description: string | null;
  typeConfig?: {
    amountFormat?: AmountFormat;
    dateFormat?: "DD-MM-YYYY" | "MM-DD-YYYY";
  };
}

export interface ParsedInvestmentIncomeRow {
  sourceRowKey: string;
  sourceRowNumber: number;
  eventType: InvestmentIncomeEventType;
  payDate: string;
  exDate: string | null;
  cashReceived: string;
  frankedAmount: string | null;
  unfrankedAmount: string | null;
  frankingCredit: string | null;
  foreignIncome: string | null;
  foreignTaxPaid: string | null;
  drp: boolean;
  drpQuantity: string | null;
  drpPrice: string | null;
  amitAmmaComponents: string | null;
  description: string | null;
}

export interface InvestmentIncomeRowIssue {
  sourceRowNumber: number;
  message: string;
}

export interface InvestmentIncomeParseResult {
  rows: ParsedInvestmentIncomeRow[];
  issues: InvestmentIncomeRowIssue[];
}

const EVENT_TYPE_ALIASES: Record<string, InvestmentIncomeEventType> = {
  dividend: "dividend",
  dividends: "dividend",
  distribution: "distribution",
  distributions: "distribution",
  "cash distribution": "distribution",
  "fund distribution": "distribution",
};

const TRUE_VALUES = new Set(["1", "true", "yes", "y", "drp", "reinvested"]);
const FALSE_VALUES = new Set(["0", "false", "no", "n", "cash", ""]);

export const EMPTY_INVESTMENT_INCOME_MAPPING: InvestmentIncomeColumnMapping = {
  eventType: null,
  payDate: null,
  exDate: null,
  cashReceived: null,
  frankedAmount: null,
  unfrankedAmount: null,
  frankingCredit: null,
  foreignIncome: null,
  foreignTaxPaid: null,
  drp: null,
  drpQuantity: null,
  drpPrice: null,
  amitAmmaComponents: null,
  description: null,
  typeConfig: { amountFormat: "AUTO", dateFormat: "DD-MM-YYYY" },
};

export function createInvestmentIncomeSourceRowKey(
  sourceImportId: string,
  sourceRowNumber: number,
  row: string[],
): string {
  return `${sourceImportId}:${sourceRowNumber}:${stableHash(JSON.stringify(row))}`;
}

export function createInvestmentIncomeSourceImportId(fileName: string, content: string): string {
  return `investment-income:${stableHash(`${fileName}:${content}`)}`;
}

export function parseInvestmentIncomeCsvRows(
  headers: string[],
  rows: string[][],
  mapping: InvestmentIncomeColumnMapping,
  sourceImportId: string,
): InvestmentIncomeParseResult {
  if (!mapping.payDate || !mapping.cashReceived) {
    return {
      rows: [],
      issues: [{ sourceRowNumber: 0, message: "Map Pay date and Cash received before importing." }],
    };
  }

  const indices = Object.fromEntries(
    Object.entries(mapping)
      .filter(([key]) => key !== "typeConfig")
      .map(([key, header]) => [key, header ? headers.indexOf(header) : -1]),
  ) as Record<Exclude<keyof InvestmentIncomeColumnMapping, "typeConfig">, number>;

  if (indices.payDate < 0 || indices.cashReceived < 0) {
    return {
      rows: [],
      issues: [{ sourceRowNumber: 0, message: "One or more mapped columns could not be found in this file." }],
    };
  }

  const numericIndices = [
    indices.cashReceived,
    indices.frankedAmount,
    indices.unfrankedAmount,
    indices.frankingCredit,
    indices.foreignIncome,
    indices.foreignTaxPaid,
    indices.drpQuantity,
    indices.drpPrice,
  ].filter((index) => index >= 0);
  const inferredFormat = inferAmountFormat(rows.flatMap((row) => numericIndices.map((index) => row[index])));
  const numberOptions = {
    amountFormat: mapping.typeConfig?.amountFormat ?? "AUTO",
    inferredFormat,
    allowGroupedIntegersWhenAmbiguous: true,
  };

  const parsedRows: ParsedInvestmentIncomeRow[] = [];
  const issues: InvestmentIncomeRowIssue[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const sourceRowNumber = rowIndex + 1;
    const payDate = parseDate(valueFor(row, indices.payDate), mapping.typeConfig?.dateFormat);
    const cashReceived = parseRequiredAmount(valueFor(row, indices.cashReceived), numberOptions);
    const eventType = parseEventType(valueFor(row, indices.eventType));
    const drp = parseBoolean(valueFor(row, indices.drp));

    if (!payDate || cashReceived === null) {
      issues.push({ sourceRowNumber, message: "Pay date and cash received must be valid values." });
      continue;
    }
    if (eventType === null) {
      issues.push({ sourceRowNumber, message: "Event type must be Dividend or Distribution when supplied." });
      continue;
    }
    if (drp === null) {
      issues.push({ sourceRowNumber, message: "DRP must be a recognised yes/no value when supplied." });
      continue;
    }

    const numericValues = {
      frankedAmount: parseOptionalAmount(valueFor(row, indices.frankedAmount), numberOptions),
      unfrankedAmount: parseOptionalAmount(valueFor(row, indices.unfrankedAmount), numberOptions),
      frankingCredit: parseOptionalAmount(valueFor(row, indices.frankingCredit), numberOptions),
      foreignIncome: parseOptionalAmount(valueFor(row, indices.foreignIncome), numberOptions),
      foreignTaxPaid: parseOptionalAmount(valueFor(row, indices.foreignTaxPaid), numberOptions),
      drpQuantity: parseOptionalAmount(valueFor(row, indices.drpQuantity), numberOptions),
      drpPrice: parseOptionalAmount(valueFor(row, indices.drpPrice), numberOptions),
    };
    if (Object.values(numericValues).some((value) => value === undefined)) {
      issues.push({ sourceRowNumber, message: "Income and tax amounts must be valid numbers when supplied." });
      continue;
    }
    const drpQuantity = numericValues.drpQuantity;
    const drpPrice = numericValues.drpPrice;
    if (drp && (drpQuantity == null || drpQuantity <= 0 || drpPrice == null || drpPrice < 0)) {
      issues.push({ sourceRowNumber, message: "DRP rows require a positive DRP quantity and DRP price." });
      continue;
    }

    const exDateRaw = valueFor(row, indices.exDate);
    const exDate = exDateRaw ? parseDate(exDateRaw, mapping.typeConfig?.dateFormat) : null;
    if (exDateRaw && !exDate) {
      issues.push({ sourceRowNumber, message: "Ex date must be a valid date when supplied." });
      continue;
    }

    parsedRows.push({
      sourceRowKey: createInvestmentIncomeSourceRowKey(sourceImportId, sourceRowNumber, row),
      sourceRowNumber,
      eventType: eventType ?? "dividend",
      payDate,
      exDate,
      cashReceived: formatAmount(cashReceived),
      frankedAmount: formatOptionalAmount(numericValues.frankedAmount),
      unfrankedAmount: formatOptionalAmount(numericValues.unfrankedAmount),
      frankingCredit: formatOptionalAmount(numericValues.frankingCredit),
      foreignIncome: formatOptionalAmount(numericValues.foreignIncome),
      foreignTaxPaid: formatOptionalAmount(numericValues.foreignTaxPaid),
      drp: drp ?? false,
      drpQuantity: formatOptionalAmount(numericValues.drpQuantity),
      drpPrice: formatOptionalAmount(numericValues.drpPrice),
      amitAmmaComponents: nullIfEmpty(valueFor(row, indices.amitAmmaComponents)),
      description: nullIfEmpty(valueFor(row, indices.description)),
    });
  }

  return { rows: parsedRows, issues };
}

function valueFor(row: string[], index: number): string | undefined {
  return index >= 0 ? row[index]?.trim() : undefined;
}

function parseEventType(value: string | undefined): InvestmentIncomeEventType | null {
  if (!value) return "dividend";
  return EVENT_TYPE_ALIASES[normalize(value)] ?? null;
}

function parseBoolean(value: string | undefined): boolean | null {
  if (value === undefined) return false;
  const normalized = normalize(value);
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return null;
}

function parseRequiredAmount(value: string | undefined, options: Parameters<typeof parseLocalizedNumber>[1]): number | null {
  const parsed = parseLocalizedNumber(value, options);
  return parsed === null || parsed < 0 ? null : parsed;
}

function parseOptionalAmount(value: string | undefined, options: Parameters<typeof parseLocalizedNumber>[1]): number | null | undefined {
  if (!value) return null;
  const parsed = parseLocalizedNumber(value, options);
  return parsed === null || parsed < 0 ? undefined : parsed;
}

function formatAmount(value: number): string {
  return value.toFixed(2);
}

function formatOptionalAmount(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : formatAmount(value);
}

function parseDate(value: string | undefined, format: "DD-MM-YYYY" | "MM-DD-YYYY" = "DD-MM-YYYY"): string | null {
  if (!value) return null;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const local = value.match(/^(\d{1,2})[\-/\.](\d{1,2})[\-/\.](\d{2,4})$/);
  if (!local) return null;
  const first = Number(local[1]);
  const second = Number(local[2]);
  const year = Number(local[3].length === 2 ? `20${local[3]}` : local[3]);
  const [day, month] = format === "MM-DD-YYYY" ? [second, first] : [first, second];
  return validDate(year, month, day);
}

function validDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date.toISOString().slice(0, 10)
    : null;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function nullIfEmpty(value: string | undefined): string | null {
  return value?.trim() || null;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
