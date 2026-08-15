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
  const cgt = report.cgt as { gross_gains_aud?: string | null; capital_losses_aud?: string | null; gross_gain_source_ids?: string[]; capital_loss_source_ids?: string[]; missing_fx_source_ids?: string[] };
  const transactions = report.transactions as { cashflow_by_currency?: SummaryRow[]; expense_by_currency?: SummaryRow[]; income_by_currency?: SummaryRow[]; rental_income_by_currency?: SummaryRow[]; rental_expense_by_currency?: SummaryRow[]; expense_categories?: Array<{ category_name: string; currency: string; amount: string | null; source_ids: string[] }>; rows?: unknown[]; excluded_rows?: unknown[] };
  const years = Array.from({ length: 6 }, (_, index) => currentYear - index);
  const row = (label: string, values: SummaryRow[] = [], status: "recorded" | "unclassified" = "recorded") => values.map((value) => ({ label, amount: value.amount, currency: value.currency, sourceCount: value.source_ids.length, status }));
  const transactionSourceHref = `/transactions?from=${financialYearStart}-07-01&to=${financialYearStart + 1}-06-30`;
  const linkedRow = (label: string, values: SummaryRow[] = [], status: "recorded" | "unclassified" = "recorded") => row(label, values, status).map((value) => ({ ...value, sourceHref: transactionSourceHref }));
  return <>
    <Header title="Tax-year report" />
    <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
      <AustralianTaxReport
        availableFinancialYears={years}
        financialYearPath="/reports/tax-year"
        report={{
          financialYearStart,
          income: [...row("Cash income", income.cash_income_by_currency), ...row("Franking credits", income.franking_credits_by_currency), ...row("Foreign income", income.foreign_income_by_currency), ...row("Foreign tax paid", income.foreign_tax_paid_by_currency)],
          cgt: { grossGains: { label: "Gross gains", amount: cgt.gross_gains_aud ?? null, currency: "AUD", sourceCount: cgt.gross_gain_source_ids?.length ?? 0 }, capitalLosses: { label: "Capital losses", amount: cgt.capital_losses_aud ?? null, currency: "AUD", sourceCount: cgt.capital_loss_source_ids?.length ?? 0 }, discountedGains: { label: "Discounted gains", amount: null, currency: "AUD", status: "unavailable" }, netCapitalGain: { label: "Net capital gain", amount: null, currency: "AUD", status: "unavailable" } },
          interest: [{ label: "Interest income", amount: null, currency: "AUD", status: "unavailable" }],
          rental: [...linkedRow("Recorded rental income", transactions.rental_income_by_currency), ...linkedRow("Recorded rental expenses", transactions.rental_expense_by_currency)],
          investmentFees: [{ label: "Investment fees", amount: null, currency: "AUD", status: "unavailable" }],
          deductibleExpenses: (transactions.expense_categories?.map((category) => ({ label: category.category_name, amount: category.amount, currency: category.currency, sourceCount: category.source_ids.length, sourceHref: transactionSourceHref, status: "unclassified" as const })) ?? []),
          unclassifiedExpenses: [...linkedRow("Recorded expenses", transactions.expense_by_currency, "unclassified")],
          cashflow: [...linkedRow("Recorded cashflow", transactions.cashflow_by_currency)],
          sources: [{ label: "Transactions", count: transactions.rows?.length ?? 0, href: transactionSourceHref }, { label: "Excluded transactions", count: transactions.excluded_rows?.length ?? 0 }],
          warnings: cgt.missing_fx_source_ids?.length ? [{ id: "missing-fx", title: "Missing FX", detail: `${cgt.missing_fx_source_ids.length} CGT allocation(s) are excluded from AUD totals.`, kind: "missing-data" }] : [],
          assumptions: report.assumptions,
        }}
        downloadHref={`/api/tax-reports/australian/${financialYearStart}/export.zip`}
      />
    </div>
  </>;
}
