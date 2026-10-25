import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ save: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/actions/transactions", () => ({ updateTransactionCashFlowPurpose: mocks.save }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import { CashFlowPurpose } from "./cash-flow-purpose";

describe("transaction cash-flow purpose", () => {
  it("persists an explicit principal portion without changing the transaction or category", async () => {
    mocks.save.mockResolvedValue({ success: true });
    const onSaved = vi.fn();
    render(<CashFlowPurpose transactionId="payment" amount={-1000} currency="AUD" onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Cash-flow purpose"), { target: { value: "loan_principal" } });
    fireEvent.change(screen.getByLabelText("Allocation portion (AUD)"), { target: { value: "600" } });
    fireEvent.click(screen.getByRole("button", { name: "Save cash-flow purpose" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("payment", "loan_principal", 600));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("loan_principal", "600.00"));
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("can restore the category default and clear a prior allocation portion", async () => {
    mocks.save.mockResolvedValue({ success: true });
    render(<CashFlowPurpose transactionId="reset" amount={-1000} currency="AUD" kind="loan_principal" allocationAmount="600.00" onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Cash-flow purpose"), { target: { value: "automatic" } });
    fireEvent.click(screen.getByRole("button", { name: "Save cash-flow purpose" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("reset", null, null));
  });
});
