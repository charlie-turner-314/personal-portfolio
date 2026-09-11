import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sync: vi.fn(),
  disconnect: vi.fn(),
  updateCredentials: vi.fn(),
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
  updateCoinSpotCredentials: mocks.updateCredentials,
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
});
