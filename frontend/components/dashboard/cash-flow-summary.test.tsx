import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CashFlowSummary } from "./cash-flow-summary";
describe("cash-flow explanation", () => {
  it("preserves deficit signs and cents instead of showing a positive saving", () => {
    render(<CashFlowSummary currency="AUD" data={{
      savingsFromIncome: -1234.56, investments: 1000, loanPrincipal: 500,
      transfersIn: 0, transfersOut: 0, netReportedCashFlow: -2734.56,
    }} />);
    expect(screen.getByText("-A$1,234.56")).toBeVisible();
    expect(screen.getByText("-A$2,734.56")).toBeVisible();
    expect(screen.getByText("Saving from income")).toBeVisible();
  });
});
