import { detectCsvDelimiter, parseDelimitedText, parseLocalizedNumber } from "@/lib/import/parsing";
import { calculateHistoricalNetWorth, HISTORICAL_METRICS, type HistoricalMetricKey } from "@/lib/import/historical-snapshot-metrics";

export type HistoricalSnapshotMapping = { month: string } & Partial<Record<HistoricalMetricKey, string>>;
export type ParsedHistoricalSnapshot = { date: string; netWorth: number | null; metrics: Partial<Record<HistoricalMetricKey, number>>; warnings: string[] };

export function suggestHistoricalSnapshotColumns(headers: string[]): HistoricalSnapshotMapping {
  const result: Partial<HistoricalSnapshotMapping> = {};
  const normalise = (header: string) => header.toLowerCase().trim();
  result.month = headers.find((header) => ["month", "date", "snapshot date", "as at"].includes(normalise(header))) || "";
  for (const metric of HISTORICAL_METRICS) result[metric.key] = headers.find((header) => metric.aliases.includes(normalise(header)));
  return result as HistoricalSnapshotMapping;
}

export function parseHistoricalSnapshotCsv(content: string, mapping: HistoricalSnapshotMapping): ParsedHistoricalSnapshot[] {
  const parsed = parseDelimitedText(content, detectCsvDelimiter(content));
  const indices = Object.fromEntries(Object.entries(mapping).map(([key, header]) => [key, parsed.headers.indexOf(header || "")]));
  return parsed.rows.map((row) => {
    const metrics: Partial<Record<HistoricalMetricKey, number>> = {};
    const warnings: string[] = [];
    for (const metric of HISTORICAL_METRICS) {
      const raw = indices[metric.key] >= 0 ? row[indices[metric.key]]?.trim() : "";
      if (!raw) continue; // a blank is genuinely absent, not zero
      const value = parseLocalizedNumber(raw, { allowGroupedIntegersWhenAmbiguous: true });
      if (value === null) warnings.push(`Invalid ${metric.label}`); else metrics[metric.key] = value;
    }
    const date = normaliseMonth(indices.month >= 0 ? row[indices.month] || "" : "");
    if (!date) warnings.push("Invalid month");
    if (!Object.keys(metrics).length) warnings.push("No metric values");
    return { date, metrics, netWorth: date && Object.keys(metrics).length ? calculateHistoricalNetWorth(metrics) : null, warnings };
  });
}

function normaliseMonth(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}$/.test(trimmed)) return monthEnd(trimmed);
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? "" : monthEnd(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
}

function monthEnd(yearMonth: string): string {
  const [year, month] = yearMonth.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}
