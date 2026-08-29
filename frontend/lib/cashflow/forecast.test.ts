import { describe, expect, it } from "vitest";
import {
  buildCashflowForecast,
  createForecastEntry,
  generateRecurringDates,
  generateRecurringForecastEntries,
  projectAccountBalances,
  summarizeForecastHorizons,
  type ForecastEntryInput,
} from "./forecast";

const entry = (patch: Partial<ForecastEntryInput> = {}): ForecastEntryInput => ({
  date: "2026-01-01",
  accountId: "checking",
  accountName: "Checking",
  amount: 100,
  direction: "outflow",
  sourceType: "planned_expense",
  sourceId: "expense-1",
  sourceLabel: "Rent",
  traceLabel: "planned_expense:expense-1:Rent",
  ...patch,
});

describe("summarizeForecastHorizons", () => {
  it("slices 30, 60, and 90 day horizons inclusively from the start date", () => {
    const summaries = summarizeForecastHorizons(
      [
        entry({ date: "2026-01-30", amount: 30, sourceId: "day-30" }),
        entry({ date: "2026-01-31", amount: 31, sourceId: "day-31" }),
        entry({ date: "2026-03-01", amount: 60, sourceId: "day-60" }),
        entry({ date: "2026-03-02", amount: 61, sourceId: "day-61" }),
        entry({ date: "2026-03-31", amount: 90, sourceId: "day-90" }),
        entry({ date: "2026-04-01", amount: 91, sourceId: "day-91" }),
      ],
      "2026-01-01"
    );

    expect(summaries.map((summary) => summary.endDate)).toEqual([
      "2026-01-30",
      "2026-03-01",
      "2026-03-31",
    ]);
    expect(summaries.map((summary) => summary.totalSpend)).toEqual([30, 121, 272]);
    expect(summaries.map((summary) => summary.entryCount)).toEqual([1, 3, 5]);
  });
});

describe("recurring generation", () => {
  it("generates dates from the anchor and clamps month-end occurrences", () => {
    expect(
      generateRecurringDates("2026-01-31", "2026-01-01", "2026-04-30", "monthly")
    ).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);

    expect(
      generateRecurringDates("2024-01-31", "2024-02-01", "2024-03-31", "monthly")
    ).toEqual(["2024-02-29", "2024-03-31"]);

    expect(
      generateRecurringDates("2026-01-07", "2026-01-01", "2026-02-01", "biweekly")
    ).toEqual(["2026-01-07", "2026-01-21"]);
  });

  it("preserves source traceability on generated recurring entries", () => {
    const generated = generateRecurringForecastEntries({
      anchorDate: "2026-01-15",
      fromDate: "2026-02-01",
      toDate: "2026-03-31",
      frequency: "monthly",
      entry: entry({
        sourceType: "recurring",
        sourceId: "subscription-1",
        sourceLabel: "Gym",
        traceLabel: "recurring:subscription-1:Gym",
      }),
    });

    expect(generated).toMatchObject([
      {
        date: "2026-02-15",
        sourceType: "recurring",
        sourceId: "subscription-1",
        sourceLabel: "Gym",
        traceLabel: "recurring:subscription-1:Gym",
      },
      {
        date: "2026-03-15",
        sourceType: "recurring",
        sourceId: "subscription-1",
        sourceLabel: "Gym",
        traceLabel: "recurring:subscription-1:Gym",
      },
    ]);
  });
});

describe("traceability", () => {
  it("keeps manual override source metadata on normalized entries", () => {
    expect(
      createForecastEntry(
        entry({
          sourceType: "manual_override",
          sourceId: "override-1",
          sourceLabel: "Temporary adjustment",
          traceLabel: "manual_override:override-1:Temporary adjustment",
        })
      )
    ).toMatchObject({
      sourceType: "manual_override",
      sourceId: "override-1",
      sourceLabel: "Temporary adjustment",
      traceLabel: "manual_override:override-1:Temporary adjustment",
    });
  });
});

describe("balance projection and warnings", () => {
  it("projects balances by entry date and reports the first low-balance date per account", () => {
    const forecast = buildCashflowForecast({
      startDate: "2026-01-01",
      startingBalances: [{ accountId: "checking", accountName: "Checking", balance: 1000 }],
      lowBalanceThresholds: [{ accountId: "checking", threshold: 200 }],
      entries: [
        entry({ date: "2026-01-10", amount: 700, sourceId: "rent" }),
        entry({ date: "2026-01-15", amount: 200, sourceId: "utilities" }),
      ],
    });

    expect(
      forecast.accountBalanceProjection.find(
        (projection) => projection.accountId === "checking" && projection.date === "2026-01-10"
      )?.projectedBalance
    ).toBe(300);
    expect(forecast.lowBalanceWarnings).toEqual([
      {
        accountId: "checking",
        accountName: "Checking",
        date: "2026-01-15",
        projectedBalance: 100,
        threshold: 200,
      },
    ]);
  });

  it("applies transfer balance movement while excluding transfers from spend totals", () => {
    const transferOut = entry({
      date: "2026-01-05",
      amount: 300,
      direction: "transfer_out",
      spendAmount: 300,
      accountId: "checking",
      accountName: "Checking",
      sourceType: "transfer",
      sourceId: "transfer-1:out",
      sourceLabel: "Move to savings",
      traceLabel: "transfer:transfer-1:out",
    });
    const transferIn = entry({
      date: "2026-01-05",
      amount: 300,
      direction: "transfer_in",
      spendAmount: 300,
      accountId: "savings",
      accountName: "Savings",
      sourceType: "transfer",
      sourceId: "transfer-1:in",
      sourceLabel: "Move to savings",
      traceLabel: "transfer:transfer-1:in",
    });
    const summaries = summarizeForecastHorizons([transferOut, transferIn], "2026-01-01");
    const projections = projectAccountBalances(
      [
        { accountId: "checking", accountName: "Checking", balance: 1000 },
        { accountId: "savings", accountName: "Savings", balance: 50 },
      ],
      [transferOut, transferIn],
      "2026-01-01",
      "2026-01-05"
    );

    expect(summaries[0]).toMatchObject({
      totalSpend: 0,
      transferIn: 300,
      transferOut: 300,
      netBalanceImpact: 0,
    });
    expect(
      projections.find(
        (projection) => projection.accountId === "checking" && projection.date === "2026-01-05"
      )?.projectedBalance
    ).toBe(700);
    expect(
      projections.find(
        (projection) => projection.accountId === "savings" && projection.date === "2026-01-05"
      )?.projectedBalance
    ).toBe(350);
  });
});
