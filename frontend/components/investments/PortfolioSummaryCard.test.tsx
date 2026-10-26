import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ portfolio: vi.fn() }));
vi.mock("@/lib/api/investments", () => ({ getPortfolio: mocks.portfolio }));
import { PortfolioSummaryCard } from "./PortfolioSummaryCard";

describe("Investment value change availability", () => {
  beforeEach(() => vi.clearAllMocks());
  it("keeps unavailable historical currency distinct from zero movement", async () => {
    mocks.portfolio.mockResolvedValue({ total_value: "1000", currency: "AUD", total_value_today_change: null });
    render(await PortfolioSummaryCard());
    expect(screen.getByText("Today’s change unavailable")).toBeTruthy();
    expect(screen.queryByText("+0.00 today")).toBeNull();
    expect(screen.getByText("1000 AUD")).toBeTruthy();
  });
  it("displays a verified zero movement", async () => {
    mocks.portfolio.mockResolvedValue({ total_value: "1000", currency: "AUD", total_value_today_change: "0.00" });
    render(await PortfolioSummaryCard());
    expect(screen.getByText("+0.00 today")).toBeTruthy();
  });
});
