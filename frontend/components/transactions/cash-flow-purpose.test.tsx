import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ save: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/actions/transactions", () => ({ updateTransactionCashFlowPurpose: mocks.save }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import { CashFlowPurpose } from "./cash-flow-purpose";

describe("transaction cash-flow portions", () => {
  it("persists a mixed repayment as complete independent portions", async () => {
    mocks.save.mockResolvedValue({ success: true });
    const onSaved = vi.fn();
    render(<CashFlowPurpose transactionId="payment" amount={-1000} currency="AUD" onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Cash-flow purpose"), { target: { value: "split" } });
    fireEvent.change(screen.getByLabelText("Portion 1 amount (AUD)"), { target: { value: "600" } });
    fireEvent.change(screen.getByLabelText("Portion 2 amount (AUD)"), { target: { value: "400" } });
    fireEvent.click(screen.getByRole("button", { name: "Save cash-flow purpose" }));
    const parts = [{ kind: "capital", detail: "loan_principal", amount: 600 }, { kind: "consumption", amount: 400 }];
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("payment", parts));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(parts));
  });
  it("can restore the category default", async () => {
    mocks.save.mockResolvedValue({ success: true });
    render(<CashFlowPurpose transactionId="reset" amount={-1000} currency="AUD" parts={[{kind:"capital",detail:"loan_principal",amount:1000}]} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Cash-flow purpose"), { target: { value: "automatic" } });
    fireEvent.click(screen.getByRole("button", { name: "Save cash-flow purpose" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("reset", null));
  });
});
