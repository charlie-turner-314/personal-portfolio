import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RealisedCgtDisposals } from "./RealisedCgtDisposals";

describe("RealisedCgtDisposals", () => {
  it("shows realised disposal values and expandable FIFO allocation detail", () => {
    render(<RealisedCgtDisposals disposals={[{
      id: "sale-1", disposal_date: "2026-08-01", quantity: "10", cost_base: "1000", proceeds: "1400", capital_gain: "400", currency: "AUD", calculation_status: "complete",
      allocations: [{ id: "lot-1", acquisition_date: "2025-07-30", quantity: "10", cost_base: "1000", proceeds: "1400", capital_gain: "400", currency: "AUD", discount_eligible: true }],
    }]} />);

    expect(screen.getByText("Realised capital gains")).toBeTruthy();
    expect(screen.getAllByText("A$ 400.00").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("1 allocation"));
    expect(screen.getByText("2025-07-30")).toBeTruthy();
    expect(screen.getByText("Eligible")).toBeTruthy();
  });

  it("makes unavailable calculations and assumptions explicit", () => {
    render(<RealisedCgtDisposals disposals={[{
      id: "sale-2", disposal_date: "2026-08-01", quantity: "2", cost_base: null, proceeds: null, capital_gain: null, currency: "AUD", calculation_status: "unavailable", allocations: [],
      unavailable_reason: "Historical FX is missing.", assumptions: ["AMIT cost-base adjustments are not included."],
    }]} />);

    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("0 allocations"));
    expect(screen.getByText(/Historical FX is missing/i)).toBeTruthy();
    expect(screen.getByText(/AMIT cost-base adjustments/i)).toBeTruthy();
  });
});
