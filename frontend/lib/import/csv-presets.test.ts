import { describe, expect, it } from "vitest";
import {
  createCsvHeaderSignature,
  suggestAustralianCsvMapping,
} from "@/lib/import/csv-presets";

describe("Australian CSV presets", () => {
  it("maps signed amount files with a running balance", () => {
    const mapping = suggestAustralianCsvMapping(
      ["Transaction Date", "Description", "Amount", "Balance"],
      [
        ["01/02/2026", "Coffee", "-4.50", "995.50"],
        ["02/02/2026", "Salary", "2000.00", "2995.50"],
      ]
    );

    expect(mapping).toMatchObject({
      date: "Transaction Date",
      amount: "Amount",
      debitAmount: null,
      creditAmount: null,
      description: "Description",
      endingBalance: "Balance",
      typeConfig: {
        isAmountSigned: true,
        dateFormat: "DD-MM-YYYY",
      },
    });
  });

  it("maps separate debit and credit amount files", () => {
    const mapping = suggestAustralianCsvMapping(
      ["Date", "Narrative", "Debit", "Credit", "Running Balance"],
      [
        ["03/04/2026", "Groceries", "87.20", "", "912.80"],
        ["04/04/2026", "Deposit", "", "250.00", "1162.80"],
      ]
    );

    expect(mapping).toMatchObject({
      date: "Date",
      amount: null,
      debitAmount: "Debit",
      creditAmount: "Credit",
      description: "Narrative",
      endingBalance: "Running Balance",
      typeConfig: {
        isAmountSigned: false,
        dateFormat: "DD-MM-YYYY",
      },
    });
  });

  it("normalizes headers for account-scoped profile signatures", () => {
    expect(createCsvHeaderSignature(["Transaction Date", "Money Out", "Money In"])).toEqual([
      "transaction date",
      "money out",
      "money in",
    ]);
  });
});
