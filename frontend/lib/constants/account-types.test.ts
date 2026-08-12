import { describe, expect, it } from "vitest";
import {
  ACCOUNT_TYPES,
  getAccountTypeLabel,
  isLiabilityAccountType,
} from "./account-types";

describe("account type constants", () => {
  it("includes first-class liability account types", () => {
    expect(ACCOUNT_TYPES.map((type) => type.value)).toEqual(
      expect.arrayContaining([
        "mortgage",
        "personal_loan",
        "car_loan",
        "hecs_help",
        "bnpl",
        "tax_debt",
        "private_debt",
        "line_of_credit",
        "other_liability",
      ]),
    );
  });

  it("detects liability account types case-insensitively", () => {
    expect(isLiabilityAccountType("MORTGAGE")).toBe(true);
    expect(isLiabilityAccountType("personal_loan")).toBe(true);
    expect(isLiabilityAccountType("checking")).toBe(false);
  });

  it("provides user-facing labels for liability account types", () => {
    expect(getAccountTypeLabel("hecs_help")).toBe("HECS/HELP Debt");
    expect(getAccountTypeLabel("other_liability")).toBe("Other Liability");
  });
});
