import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SubscriptionsGroupedList } from "./subscriptions-grouped-list";

const data = [
  {
    id: "netflix",
    name: "Netflix",
    amount: "12.5",
    currency: "EUR",
    frequency: "monthly",
    isActive: true,
    category: { id: "streaming", name: "Streaming", color: "#000000" },
  },
];

const kpis = {
  activeCount: 1,
  monthlyTotal: 12.5,
  allTimeTotal: 12.5,
  currency: "EUR",
  locale: "en-US",
};

describe("SubscriptionsGroupedList", () => {
  it.each([
    ["EUR", "en-IE", "€12.50"],
    ["USD", "en-US", "$12.50"],
    ["AUD", "en-AU", "$12.50"],
  ])("formats subscription cards in the selected %s display currency", (displayCurrency, locale, expected) => {
    render(
      <SubscriptionsGroupedList
        data={data}
        kpis={{ ...kpis, currency: displayCurrency, locale }}
        displayCurrency={displayCurrency}
        locale={locale}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onToggleActive={() => {}}
        onRowClick={() => {}}
        onVerify={() => {}}
        onDismiss={() => {}}
      />,
    );

    expect(screen.getAllByText(expected).length).toBeGreaterThanOrEqual(2);
  });
});
