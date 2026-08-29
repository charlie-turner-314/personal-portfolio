import { getAustralianFinancialYearForDate } from "@/lib/dates/australian-financial-year";

export type Range = "1W" | "1M" | "3M" | "1Y" | "FY" | "ALL";

export function rangeToDates(range: Range, now: Date = new Date()) {
  const to = now.toISOString().slice(0, 10);
  if (range === "ALL") return { from: "2010-01-01", to };
  if (range === "FY") {
    const financialYear = getAustralianFinancialYearForDate(now);
    return { from: financialYear.startDate, to: financialYear.endDate };
  }
  const days = { "1W": 7, "1M": 30, "3M": 90, "1Y": 365 }[range];
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days);
  return { from: d.toISOString().slice(0, 10), to };
}
