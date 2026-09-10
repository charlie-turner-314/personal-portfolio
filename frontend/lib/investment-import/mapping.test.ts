import { describe, expect, it } from "vitest";
import {
  EMPTY_INVESTMENT_IMPORT_MAPPING,
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
