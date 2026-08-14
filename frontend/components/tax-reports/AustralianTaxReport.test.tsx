import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AustralianTaxReport } from "./AustralianTaxReport";

const report = {
  financialYearStart: 2025,
  income: [
    { label: "Cash income", amount: "1200", currency: "AUD", sourceCount: 2, sourceHref: "/income", status: "recorded" as const },
    { label: "Franking credits", amount: "514.29", currency: "AUD", sourceCount: 1, status: "recorded" as const },
    { label: "Foreign tax paid", amount: "32", currency: "AUD", sourceCount: 1, status: "recorded" as const },
  ],
  cgt: {
    grossGains: { label: "Gross gains", amount: "500", currency: "AUD" },
    capitalLosses: { label: "Capital losses", amount: "100", currency: "AUD" },
    discountedGains: { label: "Discounted gains", amount: "200", currency: "AUD" },
    netCapitalGain: { label: "Net capital gain", amount: "200", currency: "AUD" },
  },
  interest: [{ label: "Interest income", amount: "15", currency: "AUD", status: "classified" as const }],
  rental: [{ label: "Rental income", amount: "400", currency: "AUD" }],
  investmentFees: [{ label: "Broker fees", amount: "12", currency: "AUD" }],
  deductibleExpenses: [{ label: "Accounting", amount: "75", currency: "AUD", status: "classified" as const }],
  unclassifiedExpenses: [{ label: "Other expenses", amount: "20", currency: "AUD", status: "unclassified" as const }],
  cashflow: [{ label: "Net cashflow", amount: "1308", currency: "AUD" }],
  sources: [{ label: "Transactions", count: 4, href: "/transactions" }],
  warnings: [{ id: "fx", title: "Missing FX", detail: "One disposal is excluded from AUD totals.", kind: "missing-data" as const }],
  assumptions: ["Internal transfers and reimbursements are excluded."],
};

describe("AustralianTaxReport", () => {
  it("renders the required report sections, source references, warning and disclosure", () => {
    render(<AustralianTaxReport availableFinancialYears={[2024, 2025]} onFinancialYearChange={vi.fn()} report={report} />);

    expect(screen.getByText("Recorded income")).toBeTruthy();
    expect(screen.getByText("Franking credits")).toBeTruthy();
    expect(screen.getByText("Foreign tax paid")).toBeTruthy();
    expect(screen.getByText("Capital gains")).toBeTruthy();
    expect(screen.getByText("Investment fees")).toBeTruthy();
    expect(screen.getByText("Unclassified expenses")).toBeTruthy();
    expect(screen.getByText(/not tax advice/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "2 sources" })).toHaveAttribute("href", "/income");
    expect(screen.getByText(/Missing FX/i)).toBeTruthy();
    expect(screen.getByText(/Internal transfers and reimbursements are excluded/i)).toBeTruthy();
  });

  it("exposes the FY selector and calls the prop-driven download action", () => {
    const onFinancialYearChange = vi.fn();
    const onDownload = vi.fn();
    render(<AustralianTaxReport availableFinancialYears={[2024, 2025]} onDownload={onDownload} onFinancialYearChange={onFinancialYearChange} report={report} />);

    fireEvent.click(screen.getByRole("button", { name: "Download tax-year report" }));
    expect(onDownload).toHaveBeenCalledOnce();
    expect(screen.getByRole("combobox", { name: "Australian financial year" })).toBeTruthy();
    expect(onFinancialYearChange).not.toHaveBeenCalled();
  });
});
