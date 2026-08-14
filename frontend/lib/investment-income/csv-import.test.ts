import { describe, expect, it } from "vitest";
import {
  createInvestmentIncomeSourceRowKey,
  parseInvestmentIncomeCsvRows,
  type InvestmentIncomeColumnMapping,
} from "./csv-import";

const MAPPING: InvestmentIncomeColumnMapping = {
  eventType: "Event",
  payDate: "Pay date",
  exDate: "Ex date",
  cashReceived: "Cash received",
  frankedAmount: "Franked",
  unfrankedAmount: "Unfranked",
  frankingCredit: "Franking credit",
  foreignIncome: "Foreign income",
  foreignTaxPaid: "Foreign tax",
  drp: "DRP",
  drpQuantity: "DRP quantity",
  drpPrice: "DRP price",
  amitAmmaComponents: "AMIT components",
  description: "Description",
  typeConfig: { amountFormat: "DOT_DECIMAL", dateFormat: "DD-MM-YYYY" },
};

const HEADERS = [
  "Event", "Pay date", "Ex date", "Cash received", "Franked", "Unfranked",
  "Franking credit", "Foreign income", "Foreign tax", "DRP", "AMIT components", "Description", "DRP quantity", "DRP price",
];

describe("investment income CSV import helpers", () => {
  it("normalizes fully franked, foreign, and DRP income with source-row identity", () => {
    const result = parseInvestmentIncomeCsvRows(HEADERS, [[
      "Dividend", "15/07/2026", "01/07/2026", "70.00", "70.00", "0", "30.00",
      "", "", "Yes", "13U: $4.20", "ABC July dividend", "2.5", "28.00",
    ]], MAPPING, "statement-abc");

    expect(result.issues).toEqual([]);
    expect(result.rows).toEqual([expect.objectContaining({
      sourceRowKey: createInvestmentIncomeSourceRowKey("statement-abc", 1, [
        "Dividend", "15/07/2026", "01/07/2026", "70.00", "70.00", "0", "30.00",
        "", "", "Yes", "13U: $4.20", "ABC July dividend", "2.5", "28.00",
      ]),
      eventType: "dividend",
      payDate: "2026-07-15",
      exDate: "2026-07-01",
      cashReceived: "70.00",
      frankedAmount: "70.00",
      frankingCredit: "30.00",
      drp: true,
      drpQuantity: "2.50",
      drpPrice: "28.00",
      amitAmmaComponents: "13U: $4.20",
    })]);
  });

  it("supports an unfranked distribution and statement-supplied foreign tax", () => {
    const result = parseInvestmentIncomeCsvRows(HEADERS, [[
      "Distribution", "30/06/2026", "", "25.50", "", "25.50", "", "10.00", "1.50", "No", "", "ETF distribution", "", "",
    ]], MAPPING, "statement-etf");

    expect(result).toEqual({
      issues: [],
      rows: [expect.objectContaining({
        eventType: "distribution",
        payDate: "2026-06-30",
        unfrankedAmount: "25.50",
        foreignIncome: "10.00",
        foreignTaxPaid: "1.50",
        drp: false,
      })],
    });
  });

  it("keeps source keys stable for replay and distinct for a different source row", () => {
    const row = ["Dividend", "15/07/2026", "", "10.00"];
    expect(createInvestmentIncomeSourceRowKey("same-file", 1, row))
      .toBe(createInvestmentIncomeSourceRowKey("same-file", 1, row));
    expect(createInvestmentIncomeSourceRowKey("same-file", 1, row))
      .not.toBe(createInvestmentIncomeSourceRowKey("same-file", 2, row));
  });

  it("requires DRP quantity and price and carries them through when mapped", () => {
    const mapping = MAPPING;
    const headers = HEADERS;
    const withoutTrade = parseInvestmentIncomeCsvRows(headers, [[
      "Dividend", "15/07/2026", "", "70.00", "70.00", "0", "30.00", "", "", "Yes", "", "DRP", "", "",
    ]], mapping, "statement-abc");
    expect(withoutTrade.issues[0]?.message).toMatch(/DRP quantity/);

    const withTrade = parseInvestmentIncomeCsvRows(headers, [[
      "Dividend", "15/07/2026", "", "70.00", "70.00", "0", "30.00", "", "", "Yes", "", "DRP", "2.5", "28.00",
    ]], mapping, "statement-abc");
    expect(withTrade.rows[0]).toEqual(expect.objectContaining({ drpQuantity: "2.50", drpPrice: "28.00" }));
  });

  it("rejects malformed dates, amounts, event types, and DRP values without producing partial rows", () => {
    const result = parseInvestmentIncomeCsvRows(HEADERS, [
      ["Other", "31/06/2026", "", "abc", "", "", "", "", "", "Maybe", "", "Bad row"],
    ], MAPPING, "bad-file");

    expect(result.rows).toEqual([]);
    expect(result.issues).toEqual([{ sourceRowNumber: 1, message: "Pay date and cash received must be valid values." }]);
  });
});
