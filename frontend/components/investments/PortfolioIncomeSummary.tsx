"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getAustralianFinancialYearForDate, getAustralianFinancialYearRange } from "@/lib/dates/australian-financial-year";
import { currencySymbol } from "@/lib/utils/currency";
import type { PortfolioIncomeSummary as IncomeSummary } from "./income-types";

function money(value: string, currency: string) {
  const number = Number(value);
  return Number.isFinite(number) ? `${currencySymbol(currency)} ${number.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "Not provided";
}

export function PortfolioIncomeSummary({ summaries = [] }: { summaries?: IncomeSummary[] }) {
  const currentYear = getAustralianFinancialYearForDate().startYear;
  const years = Array.from(new Set([currentYear, ...summaries.map((summary) => summary.financial_year_start_year)])).sort((a, b) => b - a);
  const [year, setYear] = useState(String(currentYear));
  const summary = summaries.find((item) => item.financial_year_start_year === Number(year));
  const label = getAustralianFinancialYearRange(Number(year)).label;
  return <Card><CardHeader className="flex flex-row items-center justify-between gap-3 p-4 pb-0"><div><CardTitle className="text-sm">Investment income</CardTitle><p className="mt-1 text-xs text-muted-foreground">Amounts reflect recorded statement data, not calculated tax outcomes.</p></div><Select value={year} onValueChange={(value) => value && setYear(value)}><SelectTrigger aria-label="Australian financial year" className="w-28"><SelectValue /></SelectTrigger><SelectContent>{years.map((startYear) => <SelectItem key={startYear} value={String(startYear)}>{getAustralianFinancialYearRange(startYear).label}</SelectItem>)}</SelectContent></Select></CardHeader><CardContent className="p-4">
    {!summary ? <p className="text-sm text-muted-foreground">No investment income summary is available for {label}.</p> : <><div className="grid grid-cols-2 gap-3 md:grid-cols-4"><Metric label="Cash received" value={money(summary.cash_received, summary.currency)} /><Metric label="Franking credits" value={money(summary.franking_credits, summary.currency)} /><Metric label="Foreign income" value={money(summary.foreign_income, summary.currency)} /><Metric label="Foreign tax paid" value={money(summary.foreign_tax_paid, summary.currency)} /></div><div className="mt-4 border-t pt-4"><p className="text-xs text-muted-foreground">Trailing 12-month received income</p><p className="mt-1 text-lg font-semibold tabular-nums">{money(summary.trailing_cash_received, summary.currency)}</p>{summary.trailing_yield_pct != null && summary.yield_denominator != null ? <p className="text-sm text-muted-foreground">Trailing yield {Number(summary.trailing_yield_pct).toLocaleString("en", { maximumFractionDigits: 2 })}%</p> : <p className="text-sm text-muted-foreground">Trailing yield unavailable: no defensible valuation or cost basis is recorded.</p>}</div></>}
  </CardContent></Card>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-sm font-medium tabular-nums">{value}</p></div>; }
