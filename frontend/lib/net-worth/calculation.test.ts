import { describe, expect, it } from "vitest";
import { calculateNetWorthOverview } from "./calculation";

describe("calculateNetWorthOverview", () => {
  it("calculates gross assets, category percentages, and net worth for positive assets", () => {
    const overview = calculateNetWorthOverview([
      {
        id: "checking",
        name: "Checking",
        institution: "Bank",
        value: 1_000,
        currency: "EUR",
        source: "account",
        accountType: "checking",
      },
      {
        id: "home",
        name: "Home",
        institution: "Lisbon",
        value: "300000",
        currency: "EUR",
        source: "property",
      },
      {
        id: "portfolio",
        name: "Brokerage",
        institution: "manual",
        value: 99_000,
        currency: "EUR",
        source: "portfolio",
      },
    ], "EUR");

    expect(overview.grossAssets).toBe(400_000);
    expect(overview.totalLiabilities).toBe(0);
    expect(overview.netWorth).toBe(400_000);
    expect(overview.total).toBe(400_000);
    expect(overview.liabilities).toEqual([]);

    const cash = overview.categories.find((category) => category.key === "cash");
    const property = overview.categories.find((category) => category.key === "property");
    const investment = overview.categories.find((category) => category.key === "investment");

    expect(cash?.value).toBe(1_000);
    expect(cash?.percentage).toBe(0.25);
    expect(property?.value).toBe(300_000);
    expect(property?.percentage).toBe(75);
    expect(investment?.value).toBe(99_000);
    expect(investment?.percentage).toBe(24.75);
  });

  it("classifies a negative checking balance as a liability", () => {
    const overview = calculateNetWorthOverview([
      {
        id: "checking",
        name: "Checking",
        institution: "Bank",
        value: -250,
        currency: "EUR",
        source: "account",
        accountType: "checking",
      },
      {
        id: "savings",
        name: "Savings",
        institution: "Bank",
        value: 1_000,
        currency: "EUR",
        source: "account",
        accountType: "savings",
      },
    ], "EUR");

    expect(overview.grossAssets).toBe(1_000);
    expect(overview.totalLiabilities).toBe(250);
    expect(overview.netWorth).toBe(750);
    expect(overview.total).toBe(750);
    expect(overview.liabilities).toMatchObject([
      {
        id: "checking",
        value: 250,
        accountType: "checking",
      },
    ]);

    const cash = overview.categories.find((category) => category.key === "cash");
    expect(cash?.value).toBe(0);
    expect(cash?.accounts).toEqual([]);
  });

  it("classifies credit card and loan account types as liabilities by magnitude", () => {
    const overview = calculateNetWorthOverview([
      {
        id: "card",
        name: "Credit Card",
        institution: "Card Bank",
        value: 500,
        currency: "EUR",
        source: "account",
        accountType: "credit_card",
      },
      {
        id: "loan",
        name: "Car Loan",
        institution: "Lender",
        value: "-12500",
        currency: "EUR",
        source: "account",
        accountType: "loan",
      },
      {
        id: "cash",
        name: "Cash",
        institution: null,
        value: 20_000,
        currency: "EUR",
        source: "account",
        accountType: "cash",
      },
    ], "EUR");

    expect(overview.grossAssets).toBe(20_000);
    expect(overview.totalLiabilities).toBe(13_000);
    expect(overview.netWorth).toBe(7_000);
    expect(overview.total).toBe(7_000);
    expect(overview.liabilities.map((liability) => liability.id)).toEqual(["loan", "card"]);
    expect(overview.liabilities.map((liability) => liability.value)).toEqual([12_500, 500]);
  });
});
