import { Header } from "@/components/layout/header";
import { AustralianTaxReport } from "@/components/tax-reports/AustralianTaxReport";
import { getAustralianFinancialYearForDate } from "@/lib/dates/australian-financial-year";
import { getAustralianTaxReport } from "@/lib/api/investments";

export const dynamic = "force-dynamic";

type SummaryRow = { currency: string; amount: string | null; source_ids: string[] };

export default async function TaxYearReportPage({ searchParams }: { searchParams: Promise<{ fy?: string }> }) {
  const params = await searchParams;
  const currentYear = getAustralianFinancialYearForDate().startYear;
  const financialYearStart = Number(params.fy) || currentYear;
  const report = await getAustralianTaxReport(financialYearStart);
  const income = report.investment_income as { cash_income_by_currency?: SummaryRow[]; franking_credits_by_currency?: SummaryRow[]; foreign_income_by_currency?: SummaryRow[]; foreign_tax_paid_by_currency?: SummaryRow[] };
  const cgt = report.cgt as { gross_gains_aud?: string | null; capital_losses_aud?: string | null; missing_fx_source_ids?: string[] };
  const transactions = report.transactions as { cashflow_by_currency?: SummaryRow[]; expense_by_currency?: SummaryRow[]; income_by_currency?: SummaryRow[]; rows?: unknown[]; excluded_rows?: unknown[] };
  const years = Array.from({ length: 6 }, (_, index) => currentYear - index);
  const row = (label: string, values: SummaryRow[] = [], status: "recorded" | "unclassified" = "recorded") => values.map((value) => ({ label, amount: value.amount, currency: value.currency, sourceCount: value.source_ids.length, status }));
  return <>
    <Header title="Tax-year report" />
    <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
      <AustralianTaxReport
        availableFinancialYears={years}
        onFinancialYearChange={() => undefined}
        financialYearPath="/reports/tax-year"
        report={{
          financialYearStart,
          income: [...row("Cash income", income.cash_income_by_currency), ...row("Franking credits", income.franking_credits_by_currency), ...row("Foreign income", income.foreign_income_by_currency), ...row("Foreign tax paid", income.foreign_tax_paid_by_currency)],
          cgt: { grossGains: { label: "Gross gains", amount: cgt.gross_gains_aud ?? null, currency: "AUD" }, capitalLosses: { label: "Capital losses", amount: cgt.capital_losses_aud ?? null, currency: "AUD" }, discountedGains: { label: "Discounted gains", amount: null, currency: "AUD", status: "unavailable" }, netCapitalGain: { label: "Net capital gain", amount: null, currency: "AUD", status: "unavailable" } },
          interest: [{ label: "Interest income", amount: null, currency: "AUD", status: "unavailable" }],
          rental: [{ label: "Rental income and expenses", amount: null, currency: "AUD", status: "unavailable" }],
          investmentFees: [{ label: "Investment fees", amount: null, currency: "AUD", status: "unavailable" }],
          deductibleExpenses: [{ label: "Deductible expenses", amount: null, currency: "AUD", status: "unavailable" }],
          unclassifiedExpenses: [...row("Recorded expenses", transactions.expense_by_currency, "unclassified")],
          cashflow: [...row("Recorded cashflow", transactions.cashflow_by_currency)],
          sources: [{ label: "Transactions", count: transactions.rows?.length ?? 0 }, { label: "Excluded transactions", count: transactions.excluded_rows?.length ?? 0 }],
          warnings: cgt.missing_fx_source_ids?.length ? [{ id: "missing-fx", title: "Missing FX", detail: `${cgt.missing_fx_source_ids.length} CGT allocation(s) are excluded from AUD totals.`, kind: "missing-data" }] : [],
          assumptions: report.assumptions,
        }}
      />
    </div>
  </>;
}
