import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  createUpConnection: vi.fn(),
  disconnectBank: vi.fn(),
  disconnectUp: vi.fn(),
  triggerRecategorize: vi.fn(),
  triggerSync: vi.fn(),
  triggerUpSync: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("@/lib/actions/bank-connections", () => ({
  createUpConnection: mocks.createUpConnection,
  disconnectBank: mocks.disconnectBank,
  disconnectUp: mocks.disconnectUp,
  triggerRecategorize: mocks.triggerRecategorize,
  triggerSync: mocks.triggerSync,
  triggerUpSync: mocks.triggerUpSync,
}));

import { BankConnectionsManager } from "./bank-connections-manager";

describe("BankConnectionsManager Up connection", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const connection = {
    id: "up-connection-1", provider: "up", aspspName: "Up", aspspCountry: "AU",
    status: "active", lastSyncedAt: null, lastSyncError: null,
    consentExpiresAt: null, createdAt: null,
  };

  it("stops waiting at the wall-clock deadline without automatically restarting", async () => {
    vi.useFakeTimers();
    const fetchStatus = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ last_synced_at: null }) });
    vi.stubGlobal("fetch", fetchStatus);
    render(<BankConnectionsManager connections={[connection]} />);
    expect(screen.getByText("0s waiting on this page")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(600000); });
    expect(screen.getByText(/Sync completion could not be confirmed/)).toBeTruthy();
    expect(screen.queryByText(/waiting on this page/)).toBeNull();
    const calls = fetchStatus.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(fetchStatus).toHaveBeenCalledTimes(calls);
    expect(mocks.triggerUpSync).not.toHaveBeenCalled();
  });

  it("stops polling when the server confirms completion", async () => {
    vi.useFakeTimers();
    const fetchStatus = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ last_synced_at: "2026-10-11T00:00:00Z" }) });
    vi.stubGlobal("fetch", fetchStatus);
    render(<BankConnectionsManager connections={[connection]} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/waiting on this page/)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it("does not start automatic polling for a connection with a known sync error", () => {
    render(<BankConnectionsManager connections={[{ ...connection, lastSyncError: "Sync failed" }]} />);
    expect(screen.queryByText(/waiting on this page/)).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Sync failed");
  });

  it("shows a polled error immediately even before refreshed props arrive", async () => {
    vi.useFakeTimers();
    const fetchStatus = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ last_sync_error: "Up API returned HTTP 400" }) });
    vi.stubGlobal("fetch", fetchStatus);
    render(<BankConnectionsManager connections={[connection]} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("alert")).toHaveTextContent("Sync failed: Up API returned HTTP 400");
    expect(screen.queryByText(/waiting on this page/)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it("clears the old error on retry and keeps it cleared on completion", async () => {
    vi.useFakeTimers();
    mocks.triggerUpSync.mockResolvedValue({ success: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ last_synced_at: "2026-10-11T00:00:00Z", last_sync_error: null }) }));
    render(<BankConnectionsManager connections={[{ ...connection, lastSyncError: "Old failure" }]} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Old failure");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Sync now/i })); });
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/waiting on this page/)).toBeNull();
  });

  it.each([false, true])("shows queueing failures instead of silently stopping (throw=%s)", async (throws) => {
    if (throws) mocks.triggerUpSync.mockRejectedValue(new Error("Network unavailable"));
    else mocks.triggerUpSync.mockResolvedValue({ success: false, error: "Queue unavailable" });
    render(<BankConnectionsManager connections={[{ ...connection, lastSyncedAt: new Date() }]} />);
    fireEvent.click(screen.getByRole("button", { name: /Sync now/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(throws ? "Unable to start sync" : "Queue unavailable");
  });
  it("submits the token once and moves to account mapping", async () => {
    mocks.createUpConnection.mockResolvedValue({ success: true, connectionId: "up-connection-1" });
    render(<BankConnectionsManager connections={[]} countryCode="AU" />);

    fireEvent.change(screen.getByLabelText("Up personal access token"), {
      target: { value: "up:pat" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect Up" }));

    await waitFor(() => expect(mocks.createUpConnection).toHaveBeenCalledWith("up:pat"));
    expect(mocks.push).toHaveBeenCalledWith(
      "/settings/connect-bank/map-accounts?connectionId=up-connection-1"
    );
    expect(screen.getByLabelText("Up personal access token")).toHaveValue("");
  });

  it("shows an action error without displaying the token", async () => {
    mocks.createUpConnection.mockResolvedValue({ success: false, error: "Token was rejected" });
    render(<BankConnectionsManager connections={[]} countryCode="AU" />);

    fireEvent.change(screen.getByLabelText("Up personal access token"), {
      target: { value: "secret-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect Up" }));

    expect(await screen.findByText("Token was rejected")).toBeTruthy();
    expect(screen.queryByText("secret-token")).toBeNull();
  });
});
