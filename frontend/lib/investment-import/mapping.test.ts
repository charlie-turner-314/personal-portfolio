import { describe, expect, it } from "vitest";
import {
  EMPTY_INVESTMENT_IMPORT_MAPPING,
  isLikelySuperheroReportHeader,
  isSuperheroTransactionHeader,
  reconcileSavedInvestmentMapping,
  suggestInvestmentImportMapping,
} from "./mapping";

describe("investment import mapping", () => {
  it("suggests common generic broker headers", () => {
    const mapping = suggestInvestmentImportMapping([
      "Trade Date", "Action", "Ticker", "Units", "Unit Price", "Brokerage", "Trade ID",
    ]);
    expect(mapping).toMatchObject({
      occurred_at: "Trade Date",
      activity_type: "Action",
      asset_symbol: "Ticker",
      quantity: "Units",
      price: "Unit Price",
      fee_amount: "Brokerage",
      source_reference: "Trade ID",
    });
  });

  it("recognises and maps the documented Superhero Transaction Statement layout", () => {
    const headers = [
      "Transaction Date", "Settlement Date", "Security", "Security Code",
      "Transaction Type", "Quantity", "Average Price", "Net Amount",
      "Brokerage", "GST", "Tax",
    ];
    expect(isSuperheroTransactionHeader(headers)).toBe(true);
    expect(isLikelySuperheroReportHeader(headers)).toBe(true);
    expect(suggestInvestmentImportMapping(headers, "Superhero")).toMatchObject({
      occurred_at: "Transaction Date",
      activity_type: "Transaction Type",
      asset_symbol: "Security Code",
      asset_name: "Security",
      quantity: "Quantity",
      price: "Average Price",
      net_amount: "Net Amount",
      fee_amount: "Brokerage",
      tax_amount: "Tax",
    });
  });

  it("treats the first wider Superhero report row as a mappable header", () => {
    expect(isLikelySuperheroReportHeader(["Entity Name", "Example"])).toBe(false);
    expect(isLikelySuperheroReportHeader([
      "Payment Date", "Security Code", "Gross Amount", "Franking Credit",
    ])).toBe(true);
  });

  it("drops stale saved columns and restores case-insensitive matches", () => {
    const saved = {
      ...EMPTY_INVESTMENT_IMPORT_MAPPING,
      occurred_at: "date",
      activity_type: "Missing type",
      asset_symbol: "SYMBOL",
    };
    expect(reconcileSavedInvestmentMapping(saved, ["Date", "Symbol"])).toMatchObject({
      occurred_at: "Date",
      activity_type: null,
      asset_symbol: "Symbol",
    });
  });

  it("recognises the Crypto.com App Token Wallet header signature", () => {
    const mapping = suggestInvestmentImportMapping([
      "Timestamp (UTC)", "Transaction Description", "Currency", "Amount",
      "To Currency", "To Amount", "Native Currency", "Native Amount",
      "Native Amount (in USD)", "Transaction Kind", "Transaction Hash",
    ], "Crypto.com App");
    expect(mapping).toMatchObject({
      occurred_at: "Timestamp (UTC)",
      activity_type: "Transaction Kind",
      asset_symbol: "Currency",
      quantity: "Amount",
      counter_asset_symbol: "To Currency",
      counter_quantity: "To Amount",
      currency: "Native Currency",
      aud_value: "Native Amount",
      description: "Transaction Description",
      transaction_hash: "Transaction Hash",
    });
  });
});
