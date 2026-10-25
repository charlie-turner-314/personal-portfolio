export const CASH_FLOW_KINDS = ["activity", "investment", "loan_principal"] as const;
export type CashFlowKind = typeof CASH_FLOW_KINDS[number];

export function validateCashFlowPurpose(kind: unknown, allocation: unknown, amount: number): string | null {
  if (kind !== null && !CASH_FLOW_KINDS.includes(kind as CashFlowKind)) return "Choose a valid cash-flow purpose";
  if (allocation !== null && (typeof allocation !== "number" || !Number.isFinite(allocation) ||
    allocation <= 0 || allocation > Math.abs(amount) || Math.abs(Math.round(allocation * 100) - allocation * 100) > 0.000001)) {
    return "Allocation must be a positive amount, in cents, no greater than the transaction";
  }
  if (allocation !== null && kind !== "investment" && kind !== "loan_principal") return "Choose an allocation purpose first";
  return null;
}
