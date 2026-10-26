import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn(), add: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }) }));
vi.mock("@/lib/api/investments", () => ({ createManualAccount: mocks.create, addManualHolding: mocks.add }));
vi.mock("./SymbolSearchInput", () => ({ SymbolSearchInput: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <input aria-label="Symbol" value={value} onChange={(e) => onChange(e.target.value)} /> }));
import { ManualForm } from "./ManualForm";
function fill(index: number, symbol: string, quantity: string) {
  fireEvent.change(screen.getAllByLabelText("Symbol")[index], { target: { value: symbol } });
  fireEvent.change(screen.getAllByPlaceholderText("0.00")[index], { target: { value: quantity } });
}
describe("Manual investment entry", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.create.mockResolvedValue({ account_id: "new-account" }); mocks.add.mockResolvedValue({ holding_id: "holding" }); });
  it("creates AUD holdings and retries only failed rows in the same new account", async () => {
    mocks.add.mockResolvedValueOnce({ holding_id: "first" }).mockRejectedValueOnce(new Error("Temporary failure")).mockResolvedValueOnce({ holding_id: "second" });
    render(<ManualForm accounts={[]} onCancel={vi.fn()} />);
    fill(0, "VAS.AX", "10");
    fireEvent.click(screen.getByRole("button", { name: "Add another holding" }));
    fill(1, "BHP.AX", "5");
    fireEvent.click(screen.getByRole("button", { name: "Add 2 holdings" }));
    await screen.findByText(/1\/2 holdings added/);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create).toHaveBeenCalledWith("My Brokerage", "AUD", expect.any(String));
    expect(mocks.add).toHaveBeenNthCalledWith(1, "new-account", expect.objectContaining({ symbol: "VAS.AX", currency: "AUD" }));
    fireEvent.click(screen.getByRole("button", { name: "Add 1 holding" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/investments"));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.add).toHaveBeenCalledTimes(3);
    expect(mocks.add).toHaveBeenLastCalledWith("new-account", expect.objectContaining({ symbol: "BHP.AX" }));
  });
  it("does not create an account or discard a partially completed row", async () => {
    render(<ManualForm accounts={[]} onCancel={vi.fn()} />);
    fill(0, "VAS.AX", "10");
    fireEvent.click(screen.getByRole("button", { name: "Add another holding" }));
    fireEvent.change(screen.getAllByLabelText("Symbol")[1], { target: { value: "BHP.AX" } });
    fireEvent.click(screen.getByRole("button", { name: "Add 2 holdings" }));
    expect(await screen.findByText(/Complete every started row/)).toBeTruthy();
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.add).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
  });
  it("keeps an existing foreign-currency manual account and excludes connected accounts", () => {
    render(<ManualForm accounts={[{ id: "connected", name: "Synced broker", base_currency: "AUD", source: "ibkr_flex", can_add_holdings: false }, { id: "usd", name: "US shares", base_currency: "USD", source: "manual", can_add_holdings: true }]} onCancel={vi.fn()} />);
    expect(screen.getByText("US shares · USD")).toBeTruthy(); expect(screen.queryByText("Synced broker · AUD")).toBeNull();
  });
});
