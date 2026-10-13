import { describe, expect, it } from "vitest";
import { discoverAccountAliases, routeAccountRow } from "./account-routing";
import { suggestAustralianCsvMapping } from "./csv-presets";
import { parseImportedDate } from "./date-parsing";

const headers = ["Date and time", "Description", "Debit", "Credit", "From account", "To account", "Transaction ID"];
const mapping = { sourceAccount: "From account", destinationAccount: "To account", accountMappings: { Savings: "a", Spending: "b", Shop: null } };

describe("explicit multi-account routing", () => {
  it("suggests generic Ubank columns and parses its time-first dates", () => {
    expect(suggestAustralianCsvMapping(headers)).toMatchObject({ sourceAccount: "From account", destinationAccount: "To account", transactionId: "Transaction ID", date: "Date and time", debitAmount: "Debit", creditAmount: "Credit" });
    expect(parseImportedDate("12:13 08-10-26")?.toISOString()).toBe("2026-10-08T00:00:00.000Z");
  });
  it("discovers aliases across the full file without exact-name routing", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ["", "", "", "", i === 7 ? "Later account" : "Savings", "Spending"]);
    expect(discoverAccountAliases(headers, rows, mapping)).toEqual(["Later account", "Savings", "Spending"]);
    expect(() => routeAccountRow(headers, rows[7], mapping, 20)).toThrow("Confirm");
  });
  it("routes a credit-labelled internal movement as debit plus destination", () => {
    expect(routeAccountRow(headers, ["", "", "", "$100", "Savings", "Spending"], mapping, 100)).toEqual({ accountId: "a", destinationAccountId: "b", amount: -100, transactionType: "debit" });
  });
  it("imports a single owned side as external, and skips explicitly external rows", () => {
    expect(routeAccountRow(headers, ["", "", "", "", "Savings", "Shop"], mapping, 20)).toMatchObject({accountId: "a", amount: -20, destinationAccountId: undefined});
    expect(routeAccountRow(headers, ["", "", "", "", "Shop", "Spending"], mapping, -20)).toMatchObject({accountId: "b", amount: 20});
    expect(routeAccountRow(headers, ["", "", "", "", "Shop", ""], mapping, 20)).toBeNull();
  });
  it("rejects two aliases mapped to the same account", () => {
    expect(() => routeAccountRow(headers, ["", "", "", "", "Savings", "Spending"], { ...mapping, accountMappings: { Savings: "a", Spending: "a" } }, 20)).toThrow("different accounts");
  });
});
