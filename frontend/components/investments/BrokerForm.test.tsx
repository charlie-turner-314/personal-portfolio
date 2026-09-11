import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createBrokerConnection: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("@/lib/api/investments", () => ({
  createBrokerConnection: mocks.createBrokerConnection,
}));

import { BrokerForm } from "./BrokerForm";

describe("BrokerForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createBrokerConnection.mockResolvedValue({ connection_id: "c1", account_id: "a1" });
  });

  it("defaults to the least-privilege CoinSpot path and submits a history start date", async () => {
    render(<BrokerForm onCancel={vi.fn()} />);

    expect(screen.getByText("Read-only by design")).toBeTruthy();
    expect(screen.getByText(/locked to CoinSpot's documented/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Paste your CoinSpot API key"), {
      target: { value: "key-value" },
    });
    fireEvent.change(screen.getByPlaceholderText("Paste your CoinSpot API secret"), {
      target: { value: "secret-value" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect & sync" }));

    await waitFor(() => expect(mocks.createBrokerConnection).toHaveBeenCalledWith({
      provider: "coinspot",
      api_key: "key-value",
      api_secret: "secret-value",
      history_start_date: "2013-01-01",
      account_name: "CoinSpot Main",
      base_currency: "AUD",
    }));
    expect(mocks.push).toHaveBeenCalledWith("/investments");
  });
});
