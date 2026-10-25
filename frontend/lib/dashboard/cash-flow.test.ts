import { describe, expect, it } from "vitest";
import { validateCashFlowPurpose } from "./cash-flow";

describe("cash-flow allocation validation", () => {
  it.each([19.99, 600, 1000])("accepts valid native-currency portions %s", amount => {
    expect(validateCashFlowPurpose("loan_principal", amount, -1000)).toBeNull();
  });
  it.each([0, -1, 1001, NaN, Infinity, 1.001, "100"])("rejects invalid portions %s", amount => {
    expect(validateCashFlowPurpose("investment", amount, -1000)).not.toBeNull();
  });
  it("rejects invalid kinds and portions without an allocation kind", () => {
    expect(validateCashFlowPurpose("housing", null, -100)).not.toBeNull();
    expect(validateCashFlowPurpose(null, 10, -100)).not.toBeNull();
    expect(validateCashFlowPurpose("activity", 10, -100)).not.toBeNull();
    expect(validateCashFlowPurpose(null, null, -100)).toBeNull();
  });
});
