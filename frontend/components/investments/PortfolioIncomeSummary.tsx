"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getAustralianFinancialYearForDate, getAustralianFinancialYearRange } from "@/lib/dates/australian-financial-year";
import { currencySymbol } from "@/lib/utils/currency";
import type { PortfolioIncomeSummary as IncomeSummary } from "./income-types";

function money(value: string | null, currency: string) {
  const number = Number(value);
  return value != null && Number.isFinite(number) ? `${currencySymbol(currency)} ${number.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "Unavailable";
}

export function PortfolioIncomeSummary({ summaries = [], availableYears = [], selectedYear, onYearChange, error }: {
  summaries?: IncomeSummary[];
  availableYears?: number[];
  selectedYear?: number;
  onYearChange?: (year: number) => void;
  error?: string | null;
}) {
  const currentYear = getAustralianFinancialYearForDate().startYear;
  const [localYear, setYear] = useState(String(currentYear));
  const year = selectedYear == null ? localYear : String(selectedYear);
  const years = Array.from(new Set([currentYear, ...availableYears, ...summaries.map((summary) => summary.financial_year_start_year)])).sort((a, b) => b - a);
  const selected = summaries.filter((item) => item.financial_year_start_year === Number(year));
  const label = getAustralianFinancialYearRange(Number(year)).label;
  return <Card>
    <CardHeader className="flex flex-row items-center justify-between gap-3 p-4 pb-0">
      <div><CardTitle className="text-sm">Investment income</CardTitle><p className="mt-1 text-xs text-muted-foreground">Recorded statement amounts, grouped by native currency.</p></div>
      <Select value={year} onValueChange={(value) => { if (value) { setYear(value); onYearChange?.(Number(value)); } }}>
        <SelectTrigger aria-label="Australian financial year" className="w-28"><SelectValue>{getAustralianFinancialYearRange(Number(year)).label}</SelectValue></SelectTrigger>
        <SelectContent>{years.map((startYear) => <SelectItem key={startYear} value={String(startYear)}>{getAustralianFinancialYearRange(startYear).label}</SelectItem>)}</SelectContent>
      </Select>
    </CardHeader>
    <CardContent className="p-4 space-y-4">
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : selected.length === 0 ? <p className="text-sm text-muted-foreground">No investment income summary is available for {label}.</p> : selected.map((summary) => <section key={summary.currency} className="space-y-3">
        <p className="text-xs font-semibold">{summary.currency}</p>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Metric label="Cash received" value={money(summary.cash_received, summary.currency)} />
          <Metric label="Franking credits" value={money(summary.franking_credits, summary.currency)} />
          <Metric label="Foreign income" value={money(summary.foreign_income, summary.currency)} />
          <Metric label="Foreign tax paid" value={money(summary.foreign_tax_paid, summary.currency)} />
        </div>
        <div className="border-t pt-3"><p className="text-xs text-muted-foreground">Trailing 12-month received income</p><p className="mt-1 text-lg font-semibold tabular-nums">{money(summary.trailing_cash_received, summary.currency)}</p>
          {summary.trailing_yield_pct != null && summary.yield_denominator != null ? <p className="text-sm text-muted-foreground">Trailing yield {Number(summary.trailing_yield_pct).toLocaleString("en-AU", { maximumFractionDigits: 2 })}%</p> : <p className="text-sm text-muted-foreground">Trailing yield unavailable: no defensible valuation or cost basis is recorded.</p>}
        </div>
      </section>)}
    </CardContent>
  </Card>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-sm font-medium tabular-nums">{value}</p></div>; }
