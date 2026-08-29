import type {
  CreateInvestmentIncomeEvent,
  InvestmentIncomeEvent,
  InvestmentIncomeSummary,
} from "@/lib/api/investments";

export type { CreateInvestmentIncomeEvent, InvestmentIncomeEvent, InvestmentIncomeSummary };

export type InvestmentIncomeTotals = {
  cash_received: string;
  franking_credits: string;
  foreign_income: string;
  foreign_tax_paid: string;
  currency: string;
};

export type PortfolioIncomeSummary = InvestmentIncomeTotals & {
  financial_year_start_year: number;
  trailing_cash_received: string;
  trailing_yield_pct: string | null;
  yield_denominator: string | null;
};
