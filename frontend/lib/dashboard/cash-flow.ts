export interface CashFlowPortion {
  kind: "income" | "consumption" | "capital";
  detail?: "investment" | "loan_principal" | "other";
  amount: number; // positive native-currency magnitude; direction comes from the bank transaction
}

export function validateCashFlowPortions(parts: unknown, amount: number): string | null {
  if (parts === null) return null; // category default
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 20) return "Use between one and twenty portions";
  if (!Number.isFinite(amount) || amount === 0) return "A zero transaction cannot be split";
  let totalCents = 0;
  for (const part of parts) {
    if (!part || typeof part !== "object" || !["income", "consumption", "capital"].includes(part.kind)) return "Choose a valid purpose for every portion";
    if (part.kind === "capital" && !["investment", "loan_principal", "other"].includes(part.detail)) return "Choose a capital movement type";
    if (part.kind !== "capital" && part.detail != null) return "Only capital portions have a capital type";
    if (typeof part.amount !== "number" || !Number.isFinite(part.amount) || part.amount <= 0 ||
      Math.abs(Math.round(part.amount * 100) - part.amount * 100) > 0.000001) return "Every portion must be a positive amount in cents";
    totalCents += Math.round(part.amount * 100);
  }
  return totalCents === Math.round(Math.abs(amount) * 100) ? null : "Portions must add up to the full transaction amount";
}

/** Capital subcategories share one rule; no provenance is inferred. */
export function defaultCashFlowPortions(amount: number, categoryType: string | null, capitalDetail?: string | null): CashFlowPortion[] {
  if (capitalDetail === "investment" || capitalDetail === "loan_principal") {
    return [{ kind: "capital", detail: capitalDetail, amount: Math.abs(amount) }];
  }
  return [{ kind: categoryType === "income" ? "income" : categoryType === "expense" ? "consumption" : amount > 0 ? "income" : "consumption", amount: Math.abs(amount) }];
}

export interface CashReconciliation {
  recordedChange: number | null;
  difference: number | null;
  missingAccounts: number;
  status: "unavailable" | "incomplete" | "matched" | "difference";
}
export function reconcileCashMovement(explained: number, recorded: number | null, missingAccounts: number, missingConversions = 0): CashReconciliation {
  if (recorded === null) return { recordedChange: null, difference: null, missingAccounts, status: "unavailable" };
  if (missingConversions) return { recordedChange: recorded, difference: null, missingAccounts, status: "incomplete" };
  const difference = Math.round((recorded - explained) * 100) / 100;
  return { recordedChange: recorded, difference, missingAccounts, status: difference === 0 ? "matched" : "difference" };
}
