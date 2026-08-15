"use client";

import { RiDownloadLine, RiErrorWarningLine, RiInformationLine } from "@remixicon/react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { currencySymbol } from "@/lib/utils/currency";
import { AustralianFinancialYearSelector } from "./AustralianFinancialYearSelector";
import type { AustralianTaxReport as AustralianTaxReportData, TaxReportAmount, TaxReportWarning } from "./tax-report-types";

type AustralianTaxReportProps = {
  report: AustralianTaxReportData;
  availableFinancialYears: number[];
  onFinancialYearChange?: (year: number) => void;
  financialYearPath?: string;
  onDownload?: () => void;
  downloadHref?: string;
  downloadDisabled?: boolean;
};

function money(value: string | null, currency: string) {
  const number = Number(value);
  return value != null && Number.isFinite(number)
    ? `${currencySymbol(currency)} ${number.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "Unavailable";
}

function AmountRows({ amounts }: { amounts: TaxReportAmount[] }) {
  if (amounts.length === 0) return <p className="text-sm text-muted-foreground">No recorded amounts are available.</p>;
  return <div className="divide-y">{amounts.map((item) => <div className="flex items-start justify-between gap-4 py-2" key={`${item.label}-${item.currency}`}>
    <div><p className="text-sm">{item.label}</p>{item.status ? <p className="mt-0.5 text-xs text-muted-foreground">{item.status === "unclassified" ? "Unclassified: review required" : item.status}</p> : null}</div>
    <div className="text-right"><p className="text-sm font-medium tabular-nums">{money(item.amount, item.currency)}</p>{item.sourceCount != null ? <SourceLink count={item.sourceCount} href={item.sourceHref} /> : null}</div>
  </div>)}</div>;
}

function SourceLink({ count, href }: { count: number; href?: string }) {
  const label = `${count} source${count === 1 ? "" : "s"}`;
  return href ? <a className="text-xs text-primary underline-offset-4 hover:underline" href={href}>{label}</a> : <p className="text-xs text-muted-foreground">{label}</p>;
}

function ReportSection({ title, amounts }: { title: string; amounts: TaxReportAmount[] }) {
  return <Card><CardHeader className="p-4 pb-0"><CardTitle className="text-sm">{title}</CardTitle></CardHeader><CardContent className="p-4"><AmountRows amounts={amounts} /></CardContent></Card>;
}

function WarningList({ warnings = [] }: { warnings?: TaxReportWarning[] }) {
  if (warnings.length === 0) return null;
  return <div className="border border-amber-500/30 bg-amber-500/10 p-4" role="status">
    <div className="flex gap-2"><RiErrorWarningLine className="mt-0.5 size-4 shrink-0" /><div><p className="text-sm font-medium">Data needs review</p><ul className="mt-2 space-y-2 text-sm text-muted-foreground">{warnings.map((warning) => <li key={warning.id}><span className="font-medium text-foreground">{warning.title}:</span> {warning.detail}</li>)}</ul></div></div>
  </div>;
}

export function AustralianTaxReport({ report, availableFinancialYears, onFinancialYearChange, financialYearPath, onDownload, downloadHref, downloadDisabled }: AustralianTaxReportProps) {
  const cgtAmounts = [report.cgt.grossGains, report.cgt.capitalLosses, report.cgt.discountedGains, report.cgt.netCapitalGain];
  return <section aria-label="Australian tax-year report" className="space-y-4">
    <div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Tax-year report</h2><p className="mt-1 text-sm text-muted-foreground">Recorded values and source references for accountant review.</p></div><div className="flex items-center gap-2"><AustralianFinancialYearSelector value={report.financialYearStart} years={availableFinancialYears} onValueChange={(year) => financialYearPath ? window.location.assign(`${financialYearPath}?fy=${year}`) : onFinancialYearChange?.(year)} />{downloadHref ? <a aria-label="Download tax-year CSV pack" className={buttonVariants({ variant: "outline", size: "icon-sm", className: downloadDisabled ? "pointer-events-none opacity-50" : undefined })} href={downloadHref}><RiDownloadLine /></a> : <Button aria-label="Download tax-year CSV pack" disabled={!onDownload || downloadDisabled} onClick={onDownload} size="icon-sm" variant="outline"><RiDownloadLine /></Button>}</div></div>
    <div className="flex gap-2 border-l-2 border-primary/50 bg-muted/40 p-3 text-sm text-muted-foreground"><RiInformationLine className="mt-0.5 size-4 shrink-0" /><p>Informational only — not tax advice. The CSV pack includes source sections and a data dictionary; this report does not calculate tax payable, deductions, offsets, or eligibility.</p></div>
    <WarningList warnings={report.warnings} />
    <div className="grid gap-4 lg:grid-cols-2"><ReportSection title="Recorded income" amounts={report.income} /><ReportSection title="Capital gains" amounts={cgtAmounts} /><ReportSection title="Interest" amounts={report.interest} /><ReportSection title="Rental" amounts={report.rental} /><ReportSection title="Investment fees" amounts={report.investmentFees} /><ReportSection title="Deductible expenses" amounts={report.deductibleExpenses} /><ReportSection title="Unclassified expenses" amounts={report.unclassifiedExpenses} /><ReportSection title="Cashflow" amounts={report.cashflow} /></div>
    <Card><CardHeader className="p-4 pb-0"><CardTitle className="text-sm">Sources and assumptions</CardTitle></CardHeader><CardContent className="p-4"><div className="grid gap-4 md:grid-cols-2"><div>{report.sources?.length ? <ul className="space-y-2">{report.sources.map((source) => <li className="flex justify-between gap-3 text-sm" key={source.label}><span>{source.label}</span><SourceLink count={source.count} href={source.href} /></li>)}</ul> : <p className="text-sm text-muted-foreground">No source counts are available.</p>}</div><div>{report.assumptions?.length ? <ul className="space-y-2 text-sm text-muted-foreground">{report.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul> : <p className="text-sm text-muted-foreground">No additional assumptions were recorded.</p>}</div></div></CardContent></Card>
  </section>;
}
