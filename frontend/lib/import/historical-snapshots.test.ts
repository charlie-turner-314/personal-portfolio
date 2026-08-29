import { describe, expect, it } from "vitest";
import { calculateHistoricalNetWorth } from "./historical-snapshot-metrics";
import { parseHistoricalSnapshotCsv, suggestHistoricalSnapshotColumns } from "./historical-snapshots";

describe("historical snapshot CSV import", () => {
  it("maps Month plus a supported subset and keeps a blank cash value absent", () => {
    const content = "Month,Cash,Property Value,Mortgage\n2024-01,10000,500000,300000\n2024-02,,510000,299000\n";
    const mapping = suggestHistoricalSnapshotColumns(["Month", "Cash", "Property Value", "Mortgage"]);
    expect(parseHistoricalSnapshotCsv(content, mapping)).toMatchObject([
      { date: "2024-01-31", netWorth: 210000, metrics: { cash: 10000, propertyValue: 500000, propertyMortgage: 300000 } },
      { date: "2024-02-29", netWorth: 211000, metrics: { propertyValue: 510000, propertyMortgage: 299000 } },
    ]);
  });

  it("supports cash-only and explicit net-worth-only files", () => {
    expect(parseHistoricalSnapshotCsv("Month;Cash\n2024-01;1.234,50", { month: "Month", cash: "Cash" }))
      .toMatchObject([{ date: "2024-01-31", netWorth: 1234.5 }]);
    expect(parseHistoricalSnapshotCsv("Month,Net Worth\n2024-01,900", { month: "Month", netWorth: "Net Worth" }))
      .toMatchObject([{ date: "2024-01-31", netWorth: 900 }]);
    expect(parseHistoricalSnapshotCsv("Month,Property Value\n2024-01,450000", { month: "Month", propertyValue: "Property Value" }))
      .toMatchObject([{ date: "2024-01-31", netWorth: 450000, metrics: { propertyValue: 450000 } }]);
  });

  it("does not double count property equity alongside value and mortgage", () => {
    expect(calculateHistoricalNetWorth({ cash: 100, propertyValue: 500, propertyMortgage: 300, propertyNetEquity: 200 })).toBe(300);
    expect(calculateHistoricalNetWorth({ propertyNetEquity: 200, creditCards: 50 })).toBe(150);
    expect(calculateHistoricalNetWorth({ propertyValue: 500, propertyMortgage: -300 })).toBe(200);
  });

  it("warns instead of fabricating values for invalid month or metrics", () => {
    const rows = parseHistoricalSnapshotCsv("Month,Cash\nnot-a-date,nope", { month: "Month", cash: "Cash" });
    expect(rows[0]).toMatchObject({ date: "", netWorth: null });
    expect(rows[0].warnings).toContain("Invalid month");
    expect(rows[0].warnings).toContain("Invalid Cash");
  });
});
