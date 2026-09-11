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

  it("documents Binance read-only permissions and submits explicit historical pairs", async () => {
    render(<BrokerForm onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("combobox"));
    const option = screen.getByRole("option", { name: "Binance · read-only API" });
    fireEvent.mouseMove(option);
    fireEvent.click(option);

    expect(screen.getByText(/Disable Spot & Margin Trading/)).toBeTruthy();
    expect(screen.getByText(/sold-out historical pairs must be listed/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Paste your Binance API key"), {
      target: { value: "binance-key" },
    });
    fireEvent.change(screen.getByPlaceholderText("Paste your Binance API secret"), {
      target: { value: "binance-secret" },
    });
    fireEvent.change(screen.getByPlaceholderText("BTCAUD, ETHUSDT, BNBBTC"), {
      target: { value: "btcusdt, ethusdt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect & sync" }));

    await waitFor(() => expect(mocks.createBrokerConnection).toHaveBeenCalledWith({
      provider: "binance",
      api_key: "binance-key",
      api_secret: "binance-secret",
      history_start_date: "2017-07-01",
      trade_symbols: ["BTCUSDT", "ETHUSDT"],
      account_name: "Binance Main",
      base_currency: "AUD",
    }));
  });

  it("distinguishes Crypto.com Exchange from App CSV and requires read-only confirmation", async () => {
    render(<BrokerForm onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("combobox"));
    const option = screen.getByRole("option", { name: "Crypto.com Exchange · read-only API" });
    fireEvent.mouseMove(option);
    fireEvent.click(option);

    expect(screen.getByText(/connects the Crypto.com/)).toBeTruthy();
    expect(screen.getByText(/not the consumer App/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Paste your Crypto.com Exchange API key"), {
      target: { value: "exchange-key" },
    });
    fireEvent.change(screen.getByPlaceholderText("Paste your Crypto.com Exchange API secret"), {
      target: { value: "exchange-secret" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Connect & sync" }));

    await waitFor(() => expect(mocks.createBrokerConnection).toHaveBeenCalledWith({
      provider: "crypto_com_exchange",
      api_key: "exchange-key",
      api_secret: "exchange-secret",
      history_start_date: "2019-01-01",
      read_only_confirmed: true,
      account_name: "Crypto.com Exchange",
      base_currency: "AUD",
    }));
  });
});
