import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InvestmentIncomePanel } from "./InvestmentIncomePanel";

describe("InvestmentIncomePanel", () => {
  it("renders recorded components verbatim and marks missing AMIT/AMMA data", () => {
    render(<InvestmentIncomePanel defaultCurrency="AUD" events={[{
      id: "income-1", event_type: "distribution", pay_date: "2026-06-30", currency: "AUD", cash_received: "42.50", franking_credit: "18.21", foreign_tax_paid: "", amit_amma_components: null,
    }]} />);
    expect(screen.getByText(/A\$ 42\.50/)).toBeTruthy();
    expect(screen.getAllByText("Not provided").length).toBeGreaterThan(0);
    expect(screen.getByText("distribution")).toBeTruthy();
  });

  it("submits a manually entered income event without inferring tax fields", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<InvestmentIncomePanel defaultCurrency="AUD" onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("button", { name: /add income/i }));
    fireEvent.change(screen.getByLabelText("Pay date"), { target: { value: "2026-07-01" } });
    fireEvent.change(screen.getByLabelText("Cash received"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Franking credit"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: /save income/i }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ pay_date: "2026-07-01", cash_received: "100", franking_credit: "30", event_type: "dividend", is_drp: false })));
    expect(onCreate.mock.calls[0][0]).not.toHaveProperty("amit_amma_components");
  });

  it("requires and submits a DRP acquisition lot", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<InvestmentIncomePanel defaultCurrency="AUD" onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("button", { name: /add income/i }));
    fireEvent.change(screen.getByLabelText("Pay date"), { target: { value: "2026-07-01" } });
    fireEvent.change(screen.getByLabelText("Cash received"), { target: { value: "100" } });
    fireEvent.click(screen.getByLabelText("Reinvested through DRP"));
    fireEvent.change(screen.getByLabelText("DRP quantity"), { target: { value: "2.5" } });
    fireEvent.change(screen.getByLabelText("DRP price"), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: /save income/i }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      is_drp: true,
      drp_quantity: "2.5",
      drp_price: "40",
    })));
  });
});
