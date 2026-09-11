import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sync: vi.fn(),
  disconnect: vi.fn(),
  updateCredentials: vi.fn(),
  updatePairs: vi.fn(),
  listRuns: vi.fn(),
  diagnostics: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("@/lib/api/investments", () => ({
  syncBrokerConnection: mocks.sync,
  disconnectBrokerConnection: mocks.disconnect,
  updateBrokerApiCredentials: mocks.updateCredentials,
  updateBinanceTradeSymbols: mocks.updatePairs,
  listInvestmentIngestionRuns: mocks.listRuns,
  getBrokerConnectionDiagnostics: mocks.diagnostics,
}));

import { BrokerConnectionsPanel } from "./BrokerConnectionsPanel";

const connection = {
  id: "connection-1",
  account_id: "account-1",
  account_name: "CoinSpot Main",
  provider: "coinspot" as const,
  last_sync_at: "2026-01-10T10:00:00Z",
  last_sync_status: "partial" as const,
  last_sync_error: "CoinSpot balances differ from normalized activity; review connection details.",
  read_only_verified_at: "2026-01-10T10:00:00Z",
  consecutive_failures: 0,
  next_retry_at: null,
  health_details: {
    balances_reconciled: false,
    total_absolute_aud_difference: "100",
    differences: [{
      symbol: "BTC",
      activity_quantity: "0.25",
      provider_quantity: "0.30",
      difference: "0.05",
      aud_difference: "5000",
    }],
  },
};

describe("BrokerConnectionsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sync.mockResolvedValue(undefined);
    mocks.disconnect.mockResolvedValue(undefined);
    mocks.updateCredentials.mockResolvedValue(undefined);
    mocks.updatePairs.mockResolvedValue(undefined);
    mocks.listRuns.mockResolvedValue([]);
    mocks.diagnostics.mockResolvedValue({ format: "syllogic-investment-diagnostics-v1" });
  });

  it("shows read-only health and a clear quantity difference", () => {
    render(<BrokerConnectionsPanel connections={[connection]} />);
    expect(screen.getByText("Read-only verified")).toBeTruthy();
    expect(screen.getByText("Review difference")).toBeTruthy();
    expect(screen.getByText("0.25")).toBeTruthy();
    expect(screen.getByText("0.30")).toBeTruthy();
    expect(screen.getByText("0.05")).toBeTruthy();
  });

  it("supports an explicit refresh and credential-removing disconnect", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<BrokerConnectionsPanel connections={[connection]} />);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledWith("connection-1"));

    fireEvent.click(screen.getByRole("button", { name: "Disconnect CoinSpot Main" }));
    await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledWith("connection-1"));
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("replaces a rejected key in place and queues recovery", async () => {
    render(<BrokerConnectionsPanel connections={[{
      ...connection,
      last_sync_status: "needs_reauth",
      read_only_verified_at: null,
    }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
    fireEvent.change(screen.getByLabelText("Replacement CoinSpot API key"), {
      target: { value: "new-key" },
    });
    fireEvent.change(screen.getByLabelText("Replacement CoinSpot API secret"), {
      target: { value: "new-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify & sync" }));
    await waitFor(() => expect(mocks.updateCredentials).toHaveBeenCalledWith(
      "connection-1",
      { api_key: "new-key", api_secret: "new-secret" },
    ));
  });

  it("surfaces Binance coverage and unpriced-asset warnings", () => {
    render(<BrokerConnectionsPanel connections={[{
      ...connection,
      account_name: "Binance Main",
      provider: "binance",
      last_sync_status: "ok",
      last_sync_error: null,
      health_details: {
        balances_reconciled: true,
        missing_product_warnings: ["Funding wallet activity is not imported."],
        unpriced_assets: ["RARE"],
      },
    }]} />);
    expect(screen.getByText("Binance")).toBeTruthy();
    expect(screen.getByText("Coverage notes")).toBeTruthy();
    expect(screen.getByText(/Funding wallet activity/)).toBeTruthy();
    expect(screen.getByText(/No current AUD market route for: RARE/)).toBeTruthy();
  });

  it("updates Binance historical pairs without replacing credentials", async () => {
    render(<BrokerConnectionsPanel connections={[{
      ...connection,
      provider: "binance",
      health_details: { balances_reconciled: true, trade_symbols: ["BTCUSDT"] },
    }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit pairs" }));
    fireEvent.change(screen.getByLabelText("Binance historical Spot pairs"), {
      target: { value: "btcusdt, ethusdt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save & sync" }));
    await waitFor(() => expect(mocks.updatePairs).toHaveBeenCalledWith(
      "connection-1", ["BTCUSDT", "ETHUSDT"],
    ));
  });

  it("shows Exchange coverage distinctly and confirms replacement keys are read-only", async () => {
    render(<BrokerConnectionsPanel connections={[{
      ...connection,
      account_name: "Crypto.com Exchange",
      provider: "crypto_com_exchange",
      last_sync_status: "needs_reauth",
      last_sync_error: "Crypto.com Exchange rejected the key.",
      read_only_verified_at: "2026-01-10T10:00:00Z",
      health_details: {
        balances_reconciled: true,
        missing_product_warnings: [
          "Crypto.com App activity is not available through the Exchange connector; import the consumer App CSV separately.",
        ],
      },
    }]} />);

    expect(screen.getAllByText("Crypto.com Exchange")).toHaveLength(2);
    expect(screen.getByText("Read-only confirmed")).toBeTruthy();
    expect(screen.getByText(/consumer App CSV separately/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
    fireEvent.change(screen.getByLabelText("Replacement Crypto.com Exchange API key"), {
      target: { value: "new-key" },
    });
    fireEvent.change(screen.getByLabelText("Replacement Crypto.com Exchange API secret"), {
      target: { value: "new-secret" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Verify & sync" }));
    await waitFor(() => expect(mocks.updateCredentials).toHaveBeenCalledWith(
      "connection-1",
      {
        api_key: "new-key",
        api_secret: "new-secret",
        read_only_confirmed: true,
      },
    ));
  });
});
