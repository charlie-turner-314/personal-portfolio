import {
  getPortfolio,
  listHoldings,
  getPortfolioHistory,
  getInvestmentIncomeSummary,
  getCgtFinancialYearSummary,
} from "@/lib/api/investments";
import { InvestmentsOverview } from "@/components/investments/InvestmentsOverview";
import { InvestmentsEmpty } from "@/components/investments/InvestmentsEmpty";
import { rangeToDates } from "@/lib/utils/date-ranges";
import { getAuthenticatedSession } from "@/lib/auth-helpers";
import { isDemoRestrictedUserEmail } from "@/lib/demo-access";
import { getAustralianFinancialYearForDate } from "@/lib/dates/australian-financial-year";

export async function InvestmentsSection() {
  const { from, to } = rangeToDates("1M");
  const financialYearStart = getAustralianFinancialYearForDate().startYear;
  const [portfolio, holdings, history, incomeSummaries, cgtSummary, session] = await Promise.all([
    getPortfolio(),
    listHoldings(),
    getPortfolioHistory(from, to),
    getInvestmentIncomeSummary(financialYearStart).catch(() => []),
    getCgtFinancialYearSummary(financialYearStart).catch(() => null),
    getAuthenticatedSession(),
  ]);

  const isDemoRestricted = isDemoRestrictedUserEmail(session?.user?.email);

  if (holdings.length === 0) {
    return <InvestmentsEmpty isDemoRestricted={isDemoRestricted} />;
  }

  return (
    <InvestmentsOverview
      portfolio={portfolio}
      holdings={holdings}
      initialHistory={history}
      initialRange="1M"
      incomeSummaries={incomeSummaries.map((summary) => ({
        financial_year_start_year: summary.financial_year_start,
        currency: summary.currency,
        cash_received: summary.cash_income,
        franking_credits: summary.franking_credits,
        foreign_income: summary.foreign_income,
        foreign_tax_paid: summary.foreign_tax_paid,
        trailing_cash_received: summary.cash_income,
        trailing_yield_pct: null,
        yield_denominator: null,
      }))}
      cgtSummaries={cgtSummary ? [{
        financial_year_start_year: cgtSummary.financial_year_start,
        currency: "AUD",
        gross_capital_gains: cgtSummary.gross_gains_aud,
        capital_losses: cgtSummary.capital_losses_aud,
        discounted_gains: cgtSummary.discounted_gains_aud,
        net_capital_gain: cgtSummary.net_capital_gain_before_losses_aud,
        disposal_count: cgtSummary.allocation_count,
        calculation_status: cgtSummary.missing_fx_allocation_count > 0 ? "partial" : "complete",
        assumptions: cgtSummary.assumptions,
        unavailable_reason: cgtSummary.missing_fx_allocation_count > 0 ? `${cgtSummary.missing_fx_allocation_count} allocation(s) have missing FX.` : null,
      }] : []}
      isDemoRestricted={isDemoRestricted}
    />
  );
}
