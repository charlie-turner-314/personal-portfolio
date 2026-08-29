import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PortfolioIncomeSummary } from "./PortfolioIncomeSummary";
import { getAustralianFinancialYearForDate } from "@/lib/dates/australian-financial-year";

const CURRENT_FY = getAustralianFinancialYearForDate().startYear;

describe("PortfolioIncomeSummary", () => {
  it("separates Australian-FY tax components and reports unavailable yield", () => {
    render(<PortfolioIncomeSummary summaries={[{
      financial_year_start_year: CURRENT_FY,
      currency: "AUD",
      cash_received: "120", franking_credits: "51.43", foreign_income: "10", foreign_tax_paid: "1.50", trailing_cash_received: "120", trailing_yield_pct: null, yield_denominator: null,
    }]} />);
    expect(screen.getByText("Franking credits")).toBeTruthy();
    expect(screen.getByText("Foreign income")).toBeTruthy();
    expect(screen.getByText("Foreign tax paid")).toBeTruthy();
    expect(screen.getByText(/Trailing yield unavailable/i)).toBeTruthy();
  });

  it("shows trailing yield only when the summary supplies a denominator", () => {
    render(<PortfolioIncomeSummary summaries={[{
      financial_year_start_year: CURRENT_FY,
      currency: "AUD",
      cash_received: "120", franking_credits: "0", foreign_income: "0", foreign_tax_paid: "0", trailing_cash_received: "120", trailing_yield_pct: "3.25", yield_denominator: "3692.31",
    }]} />);
    expect(screen.getByText(/Trailing yield 3.25%/i)).toBeTruthy();
  });
});
