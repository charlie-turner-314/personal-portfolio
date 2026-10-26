"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getAustralianFinancialYearForDate, getAustralianFinancialYearRange } from "@/lib/dates/australian-financial-year";
import { currencySymbol } from "@/lib/utils/currency";
import type { CgtFinancialYearSummary } from "./cgt-types";

function money(value: string | null, currency: string) {
  const number = Number(value);
  return value != null && Number.isFinite(number)
    ? `${currencySymbol(currency)} ${number.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "Unavailable";
}

export function PortfolioCgtSummary({ summaries = [], availableYears = [], selectedYear, onYearChange, error }: {
  summaries?: CgtFinancialYearSummary[]; availableYears?: number[]; selectedYear?: number;
  onYearChange?: (year: number) => void; error?: string | null;
}) {
  const currentYear = getAustralianFinancialYearForDate().startYear;
  const years = Array.from(new Set([currentYear, ...availableYears, ...summaries.map((summary) => summary.financial_year_start_year)])).sort((a, b) => b - a);
  const [localYear, setYear] = useState(String(currentYear));
  const year = selectedYear == null ? localYear : String(selectedYear);
  const summary = summaries.find((item) => item.financial_year_start_year === Number(year));
  const label = getAustralianFinancialYearRange(Number(year)).label;

  return <Card>
    <CardHeader className="flex flex-row items-start justify-between gap-3 p-4 pb-0">
      <div><CardTitle className="text-sm">Capital gains</CardTitle><p className="mt-1 text-xs text-muted-foreground">Australian FY summary from recorded disposal allocations. The allocation result is not a final net capital gain; loss ordering and tax circumstances are not calculated.</p></div>
      <Select value={year} onValueChange={(value) => { if (value) { setYear(value); onYearChange?.(Number(value)); } }}><SelectTrigger aria-label="Capital gains financial year" className="w-28 shrink-0"><SelectValue>{getAustralianFinancialYearRange(Number(year)).label}</SelectValue></SelectTrigger><SelectContent>{years.map((startYear) => <SelectItem key={startYear} value={String(startYear)}>{getAustralianFinancialYearRange(startYear).label}</SelectItem>)}</SelectContent></Select>
    </CardHeader>
    <CardContent className="p-4">
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : !summary ? <p className="text-sm text-muted-foreground">No capital gains summary is available for {label}.</p> : <><div className="grid grid-cols-2 gap-3 md:grid-cols-4"><Metric label="Gross gains" value={money(summary.gross_capital_gains, summary.currency)} /><Metric label="Capital losses" value={money(summary.capital_losses, summary.currency)} /><Metric label="Discounted gains" value={money(summary.discounted_gains, summary.currency)} /><Metric label="Recorded allocation result" value={money(summary.net_capital_gain, summary.currency)} /></div><p className="mt-4 border-t pt-4 text-xs text-muted-foreground">{summary.disposal_count} recorded disposal{summary.disposal_count === 1 ? "" : "s"}. {summary.calculation_status === "complete" ? "Recorded allocation FX is available. This does not certify complete investment history." : summary.unavailable_reason ? `Unavailable: ${summary.unavailable_reason}` : "Some allocation inputs are incomplete and require review."}</p>{summary.assumptions?.length ? <p className="mt-2 text-xs text-muted-foreground">Assumptions: {summary.assumptions.join(" ")}</p> : null}</>}
    </CardContent>
  </Card>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-sm font-medium tabular-nums">{value}</p></div>; }
