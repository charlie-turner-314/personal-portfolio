import {
  getPortfolio,
  listHoldings,
  getPortfolioHistory,
  getInvestmentIncomeSummary,
  getCgtFinancialYearSummary,
  getBrokerConnections,
  getInvestmentReportingYears,
} from "@/lib/api/investments";
import { InvestmentsOverview } from "@/components/investments/InvestmentsOverview";
import { InvestmentsEmpty } from "@/components/investments/InvestmentsEmpty";
import { rangeToDates } from "@/lib/utils/date-ranges";
import { getAuthenticatedSession } from "@/lib/household/financial-auth";
import { isDemoRestrictedUserEmail } from "@/lib/demo-access";
import { getAustralianFinancialYearForDate } from "@/lib/dates/australian-financial-year";

export async function InvestmentsSection({ financialYearStart: requestedYear, personScope = "self" }: { financialYearStart?: number; personScope?: string } = {}) {
  const { from, to } = rangeToDates("1M");
  const financialYearStart = requestedYear ?? getAustralianFinancialYearForDate().startYear;
  const [portfolio, holdings, historyResult, incomeResult, cgtResult, connections, session, financialYears, trailingResult] = await Promise.all([
    getPortfolio(personScope),
    listHoldings(undefined, personScope),
    getPortfolioHistory(from, to, personScope).then((data) => ({ data, error: undefined }), () => ({ data: [], error: "Portfolio history is unavailable or contains unverified currency. Rebuild from source records before using it." })),
    getInvestmentIncomeSummary(financialYearStart, undefined, false, personScope).then((data) => ({ data, error: undefined }), () => ({ data: [], error: "Investment income could not be loaded. Retry this page." })),
    getCgtFinancialYearSummary(financialYearStart, personScope).then((data) => ({ data, error: undefined }), () => ({ data: null, error: "Capital gains could not be loaded. Retry this page." })),
    getBrokerConnections(),
    getAuthenticatedSession(),
    getInvestmentReportingYears(),
    getInvestmentIncomeSummary(financialYearStart, undefined, true, personScope).catch(() => null),
  ]);

  const incomeCurrencies = new Set([...incomeResult.data.map((item) => item.currency), ...(trailingResult ?? []).map((item) => item.currency)]);
  const incomeSummaries = [...incomeCurrencies].map((currency) => incomeResult.data.find((item) => item.currency === currency) ?? {
    financial_year_start: financialYearStart, currency, cash_income: "0", franking_credits: "0", foreign_income: "0", foreign_tax_paid: "0", tfn_withholding: "0",
  });
  const cgtSummary = cgtResult.data;
  const isDemoRestricted = isDemoRestrictedUserEmail(session?.user?.email);

  if (holdings.length === 0 && connections.length === 0 && portfolio.accounts.length === 0) {
    return <InvestmentsEmpty isDemoRestricted={isDemoRestricted} />;
  }

  return (
    <InvestmentsOverview
      personScope={personScope}
      portfolio={portfolio}
      holdings={holdings}
      initialHistory={historyResult.data}
      initialRange="1M"
      incomeSummaries={incomeSummaries.map((summary) => ({
        financial_year_start_year: summary.financial_year_start,
        currency: summary.currency,
        cash_received: summary.cash_income,
        franking_credits: summary.franking_credits,
        foreign_income: summary.foreign_income,
        foreign_tax_paid: summary.foreign_tax_paid,
        trailing_cash_received: trailingResult?.find((item) => item.currency === summary.currency)?.cash_income ?? (trailingResult ? "0" : null),
        trailing_yield_pct: null,
        yield_denominator: null,
      }))}
      cgtSummaries={cgtSummary ? [{
        financial_year_start_year: cgtSummary.financial_year_start,
        currency: "AUD",
        gross_capital_gains: cgtSummary.gross_gains_aud,
        capital_losses: cgtSummary.capital_losses_aud,
        discounted_gains: cgtSummary.discounted_gains_aud,
        net_capital_gain: cgtSummary.allocation_result_aud,
        disposal_count: cgtSummary.disposal_count,
        calculation_status: cgtSummary.missing_fx_allocation_count > 0 || cgtSummary.coverage_warnings.length > 0 ? "partial" : "complete",
        assumptions: cgtSummary.assumptions,
        unavailable_reason: [cgtSummary.missing_fx_allocation_count > 0 ? `${cgtSummary.missing_fx_allocation_count} allocation(s) have missing FX.` : null, ...cgtSummary.coverage_warnings].filter(Boolean).join(" ") || null,
      }] : []}
      connections={connections}
      financialYears={financialYears}
      selectedFinancialYear={financialYearStart}
      reportErrors={{ income: incomeResult.error, cgt: cgtResult.error, history: historyResult.error }}
      isDemoRestricted={isDemoRestricted}
    />
  );
}
