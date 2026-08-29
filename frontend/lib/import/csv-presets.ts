import { inferAmountFormat, type AmountFormat } from "@/lib/import/parsing";

export interface SuggestedCsvColumnMapping {
  date: string | null;
  amount: string | null;
  debitAmount: string | null;
  creditAmount: string | null;
  description: string | null;
  merchant: string | null;
  transactionType: string | null;
  fee: string | null;
  state: string | null;
  startingBalance: string | null;
  endingBalance: string | null;
  typeConfig: {
    creditValue?: string;
    debitValue?: string;
    isAmountSigned: boolean;
    amountFormat: AmountFormat;
    dateFormat: "DD-MM-YYYY" | "MM-DD-YYYY";
    completedStateValue?: string;
  };
}

const HEADER_ALIASES = {
  date: ["date", "transaction date", "posted date", "effective date", "process date"],
  amount: ["amount", "transaction amount", "value", "net amount"],
  debitAmount: ["debit", "debit amount", "withdrawal", "withdrawals", "money out", "paid out"],
  creditAmount: ["credit", "credit amount", "deposit", "deposits", "money in", "paid in"],
  description: [
    "description",
    "narrative",
    "details",
    "transaction details",
    "particulars",
    "reference",
  ],
  merchant: ["merchant", "payee", "payer", "name", "counterparty"],
  transactionType: ["type", "transaction type", "credit debit", "dr cr", "direction"],
  fee: ["fee", "fees", "charge", "commission"],
  startingBalance: ["opening balance", "start balance", "starting balance", "balance before"],
  endingBalance: ["balance", "running balance", "account balance", "closing balance", "ending balance", "balance after"],
  state: ["state", "status"],
} as const;

function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findHeader(headers: string[], aliases: readonly string[]): string | null {
  const normalizedHeaders = headers.map((header) => ({
    original: header,
    normalized: normalizeHeader(header),
  }));

  for (const alias of aliases) {
    const normalizedAlias = normalizeHeader(alias);
    const exact = normalizedHeaders.find((header) => header.normalized === normalizedAlias);
    if (exact) {
      return exact.original;
    }
  }

  for (const alias of aliases) {
    const normalizedAlias = normalizeHeader(alias);
    const partial = normalizedHeaders.find((header) => header.normalized.includes(normalizedAlias));
    if (partial) {
      return partial.original;
    }
  }

  return null;
}

function columnSamples(headers: string[], rows: string[][], columnName: string | null): string[] {
  if (!columnName) {
    return [];
  }

  const index = headers.indexOf(columnName);
  if (index < 0) {
    return [];
  }

  return rows
    .slice(0, 50)
    .map((row) => row[index])
    .filter((value): value is string => Boolean(value?.trim()));
}

function inferDateFormat(dateSamples: string[]): "DD-MM-YYYY" | "MM-DD-YYYY" {
  for (const sample of dateSamples) {
    const match = sample.trim().match(/^(\d{1,2})[\-/\.](\d{1,2})[\-/\.](\d{2,4})/);
    if (!match) {
      continue;
    }

    const first = Number(match[1]);
    const second = Number(match[2]);

    if (first > 12) {
      return "DD-MM-YYYY";
    }

    if (second > 12) {
      return "MM-DD-YYYY";
    }
  }

  return "DD-MM-YYYY";
}

function inferSignedAmount(headers: string[], rows: string[][], amountColumn: string | null): boolean {
  return columnSamples(headers, rows, amountColumn).some((sample) => {
    const trimmed = sample.trim();
    return trimmed.startsWith("-") || trimmed.endsWith("-") || /^\(.*\)$/.test(trimmed);
  });
}

export function createCsvHeaderSignature(headers: string[]): string[] {
  return headers.map(normalizeHeader).filter(Boolean);
}

export function suggestAustralianCsvMapping(
  headers: string[],
  sampleRows: string[][] = []
): SuggestedCsvColumnMapping {
  const debitAmount = findHeader(headers, HEADER_ALIASES.debitAmount);
  const creditAmount = findHeader(headers, HEADER_ALIASES.creditAmount);
  const amount = debitAmount || creditAmount
    ? null
    : findHeader(headers, HEADER_ALIASES.amount);
  const date = findHeader(headers, HEADER_ALIASES.date);
  const state = findHeader(headers, HEADER_ALIASES.state);
  const amountSamples = [
    ...columnSamples(headers, sampleRows, amount),
    ...columnSamples(headers, sampleRows, debitAmount),
    ...columnSamples(headers, sampleRows, creditAmount),
  ];
  const inferredAmountFormat = inferAmountFormat(amountSamples);

  return {
    date,
    amount,
    debitAmount,
    creditAmount,
    description: findHeader(headers, HEADER_ALIASES.description),
    merchant: findHeader(headers, HEADER_ALIASES.merchant),
    transactionType: findHeader(headers, HEADER_ALIASES.transactionType),
    fee: findHeader(headers, HEADER_ALIASES.fee),
    state,
    startingBalance: findHeader(headers, HEADER_ALIASES.startingBalance),
    endingBalance: findHeader(headers, HEADER_ALIASES.endingBalance),
    typeConfig: {
      isAmountSigned: Boolean(amount && inferSignedAmount(headers, sampleRows, amount)),
      amountFormat: inferredAmountFormat === "AMBIGUOUS" ? "AUTO" : inferredAmountFormat,
      dateFormat: inferDateFormat(columnSamples(headers, sampleRows, date)),
      completedStateValue: state ? "completed" : undefined,
    },
  };
}
