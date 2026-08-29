import {
  getAustralianFinancialYearForDate,
  type AustralianFinancialYearRange,
} from "@/lib/dates/australian-financial-year";

export const SUPER_CONTRIBUTION_KINDS = [
  "employer_sg",
  "salary_sacrifice",
  "personal_concessional",
  "personal_non_concessional",
  "fee",
  "insurance",
] as const;

export type SuperContributionKind = (typeof SUPER_CONTRIBUTION_KINDS)[number];

export interface SuperContributionForProgress {
  date: Date | string;
  amount: number | string;
  kind: SuperContributionKind;
}

export interface SuperCapConfiguration {
  concessionalCap: number | string | null;
  nonConcessionalCap: number | string | null;
}

export interface SuperCapProgress {
  financialYear: AustralianFinancialYearRange;
  concessional: { used: number; cap: number | null; remaining: number | null; configured: boolean };
  nonConcessional: { used: number; cap: number | null; remaining: number | null; configured: boolean };
}

const CONCESSIONAL_KINDS = new Set<SuperContributionKind>([
  "employer_sg",
  "salary_sacrifice",
  "personal_concessional",
]);

function amountOf(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nonNegativeNumberOrNull(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function capProgress(used: number, cap: number | string | null) {
  const parsedCap = nonNegativeNumberOrNull(cap);
  const configured = parsedCap !== null;
  return {
    used,
    cap: configured ? parsedCap : null,
    remaining: configured ? Math.max(0, parsedCap - used) : null,
    configured,
  };
}

function contributionDate(value: Date | string): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 12));

  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    ? date
    : null;
}

export function calculateSuperCapProgress(
  contributions: SuperContributionForProgress[],
  financialYearStart: number,
  configuration: SuperCapConfiguration | null,
): SuperCapProgress {
  const financialYear = getAustralianFinancialYearForDate(
    new Date(Date.UTC(financialYearStart, 6, 1)),
  );
  let concessional = 0;
  let nonConcessional = 0;

  for (const contribution of contributions) {
    const date = contributionDate(contribution.date);
    if (!date) continue;
    const eventYear = getAustralianFinancialYearForDate(date);
    if (eventYear.startYear !== financialYearStart) continue;
    const amount = amountOf(contribution.amount);
    if (amount <= 0) continue;
    if (CONCESSIONAL_KINDS.has(contribution.kind)) concessional += amount;
    if (contribution.kind === "personal_non_concessional") nonConcessional += amount;
  }

  return {
    financialYear,
    concessional: capProgress(concessional, configuration?.concessionalCap ?? null),
    nonConcessional: capProgress(nonConcessional, configuration?.nonConcessionalCap ?? null),
  };
}

export function isSuperContributionKind(value: string): value is SuperContributionKind {
  return (SUPER_CONTRIBUTION_KINDS as readonly string[]).includes(value);
}
