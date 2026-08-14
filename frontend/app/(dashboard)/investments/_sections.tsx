import {
  getPortfolio,
  listHoldings,
  getPortfolioHistory,
  getInvestmentIncomeSummary,
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
  const [portfolio, holdings, history, incomeSummaries, session] = await Promise.all([
    getPortfolio(),
    listHoldings(),
    getPortfolioHistory(from, to),
    getInvestmentIncomeSummary(financialYearStart).catch(() => []),
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
      isDemoRestricted={isDemoRestricted}
    />
  );
}
