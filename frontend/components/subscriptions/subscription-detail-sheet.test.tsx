import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SubscriptionDetailSheet } from "./subscription-detail-sheet";

vi.mock("@/lib/actions/subscriptions", () => ({
  getSubscriptionCostAggregations: vi
    .fn()
    .mockResolvedValue({ thisYear: 25, allTime: 50 }),
  getLinkedTransactions: vi.fn().mockResolvedValue([]),
  matchTransactionsToSubscription: vi.fn(),
}));

describe("SubscriptionDetailSheet", () => {
  it.each([
    ["EUR", "en-IE", "€12.50"],
    ["USD", "en-US", "$12.50"],
    ["AUD", "en-AU", "$12.50"],
  ])("formats the detail card in the selected %s display currency", async (displayCurrency, locale, expected) => {
    render(
      <SubscriptionDetailSheet
        subscription={{
          id: "netflix",
          name: "Netflix",
          amount: "12.5",
          frequency: "monthly",
          importance: 2,
        } as never}
        open
        onOpenChange={() => {}}
        onEdit={() => {}}
        onRefresh={() => {}}
        displayCurrency={displayCurrency}
        locale={locale}
      />
    );

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(expected)).toBeInTheDocument();
  });
});
