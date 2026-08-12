import { describe, expect, it } from "vitest";
import {
  calculatePropertyEquity,
  getLiabilityMagnitude,
  getLinkedLiabilityAccountIds,
} from "./equity";

describe("property equity helpers", () => {
  it("subtracts linked mortgage debt from gross property value", () => {
    const result = calculatePropertyEquity(
      { id: "home", currentValue: "750000" },
      [
        { id: "mortgage", accountType: "mortgage", functionalBalance: "-520000" },
        { id: "offset", accountType: "savings", functionalBalance: "25000" },
      ],
      [{ propertyId: "home", accountId: "mortgage" }],
    );

    expect(result).toEqual({
      propertyId: "home",
      grossValue: 750000,
      linkedDebt: 520000,
      equity: 230000,
    });
  });

  it("ignores linked non-liability accounts", () => {
    expect(
      calculatePropertyEquity(
        { id: "home", currentValue: 100000 },
        [{ id: "offset", accountType: "savings", functionalBalance: "-1000" }],
        [{ propertyId: "home", accountId: "offset" }],
      ).linkedDebt,
    ).toBe(0);
  });

  it("handles positive liability balances as liability magnitudes", () => {
    expect(getLiabilityMagnitude({
      id: "loan",
      accountType: "personal_loan",
      functionalBalance: "12000",
    })).toBe(12000);
  });

  it("returns linked account ids for standalone liability suppression", () => {
    expect([...getLinkedLiabilityAccountIds([
      { propertyId: "home", accountId: "mortgage" },
      { propertyId: "unit", accountId: "investment-loan" },
    ])]).toEqual(["mortgage", "investment-loan"]);
  });
});
