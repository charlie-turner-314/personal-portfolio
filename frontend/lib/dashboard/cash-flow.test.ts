import { describe, expect, it } from "vitest";
import { validateCashFlowPortions, reconcileCashMovement } from "./cash-flow";

describe("generic cash-flow portions", () => {
  it("supports interest, principal and investment in one payment with a single capital rule", () => {
    expect(validateCashFlowPortions([
      { kind: "consumption", amount: 100 }, { kind: "capital", detail: "loan_principal", amount: 600 },
      { kind: "capital", detail: "investment", amount: 300 },
    ], -1000)).toBeNull();
  });
  it.each([0, -1, NaN, Infinity, 1.001, "100"])("rejects invalid portions %s", amount => {
    expect(validateCashFlowPortions([{ kind: "consumption", amount }], -1000)).not.toBeNull();
  });
  it("requires complete amounts and valid purposes, while allowing category defaults", () => {
    expect(validateCashFlowPortions(null, -100)).toBeNull();
    expect(validateCashFlowPortions([{ kind: "capital", detail: "other", amount: 19.99 }], -19.99)).toBeNull();
    expect(validateCashFlowPortions([{ kind: "consumption", amount: 99 }], -100)).not.toBeNull();
    expect(validateCashFlowPortions([{ kind: "income", amount: 101 }], 100)).not.toBeNull();
    expect(validateCashFlowPortions([{ kind: "capital", amount: 100 }], -100)).not.toBeNull();
    expect(validateCashFlowPortions([{ kind: "contribution", amount: 100 }], 100)).not.toBeNull();
  });
});
describe("independent cash reconciliation", () => {
  it("leaves missing boundary balances unavailable rather than inventing a cash change", () => {
    expect(reconcileCashMovement(3000, null, 2)).toMatchObject({ recordedChange: null, difference: null, status: "unavailable" });
  });
  it("shows an unmatched movement as a reconciliation difference, not overspending", () => {
    expect(reconcileCashMovement(3000, 3500, 0)).toMatchObject({ recordedChange: 3500, difference: 500, status: "difference" });
    expect(reconcileCashMovement(3000, 3000, 0).status).toBe("matched");
    expect(reconcileCashMovement(3000, 3000, 0, 1)).toMatchObject({ status: "incomplete", difference: null });
  });
});
