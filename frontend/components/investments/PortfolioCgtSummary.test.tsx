import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getAustralianFinancialYearForDate } from "@/lib/dates/australian-financial-year";
import { PortfolioCgtSummary } from "./PortfolioCgtSummary";

const CURRENT_FY = getAustralianFinancialYearForDate().startYear;

describe("PortfolioCgtSummary", () => {
  it("shows Australian-FY gain, loss and discounted-gain values", () => {
    render(<PortfolioCgtSummary summaries={[{
      financial_year_start_year: CURRENT_FY, currency: "AUD", gross_capital_gains: "1000", capital_losses: "200", discounted_gains: "500", net_capital_gain: "300", disposal_count: 2, calculation_status: "complete",
    }]} />);

    expect(screen.getByText("Gross gains")).toBeTruthy();
    expect(screen.getByText("Capital losses")).toBeTruthy();
    expect(screen.getByText("Discounted gains")).toBeTruthy();
    expect(screen.getByText("A$ 300.00")).toBeTruthy();
    expect(screen.getByText(/2 recorded disposals/i)).toBeTruthy();
  });

  it("shows an explicit unavailable reason for partial data", () => {
    render(<PortfolioCgtSummary summaries={[{
      financial_year_start_year: CURRENT_FY, currency: "AUD", gross_capital_gains: null, capital_losses: null, discounted_gains: null, net_capital_gain: null, disposal_count: 1, calculation_status: "partial", unavailable_reason: "One disposal is missing historical FX.",
    }]} />);

    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(screen.getByText(/One disposal is missing historical FX/i)).toBeTruthy();
  });
});
