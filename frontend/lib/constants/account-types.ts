export const LIABILITY_ACCOUNT_TYPE_VALUES = [
  "credit",
  "credit_card",
  "mortgage",
  "personal_loan",
  "car_loan",
  "hecs_help",
  "bnpl",
  "tax_debt",
  "private_debt",
  "loan",
  "line_of_credit",
  "other_liability",
] as const;

export const ACCOUNT_TYPES = [
  { value: "checking", label: "Transaction Account" },
  { value: "savings", label: "Savings Account" },
  { value: "credit_card", label: "Credit Card" },
  { value: "mortgage", label: "Mortgage" },
  { value: "personal_loan", label: "Personal Loan" },
  { value: "car_loan", label: "Car Loan" },
  { value: "hecs_help", label: "HECS/HELP Debt" },
  { value: "bnpl", label: "BNPL" },
  { value: "tax_debt", label: "Tax Debt" },
  { value: "private_debt", label: "Private Debt" },
  { value: "line_of_credit", label: "Line of Credit" },
  { value: "other_liability", label: "Other Liability" },
  { value: "investment", label: "Investment Account" },
  { value: "superannuation", label: "Superannuation" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
] as const;

export type AccountTypeValue = (typeof ACCOUNT_TYPES)[number]["value"];

export const LIABILITY_REPAYMENT_FREQUENCIES = [
  { value: "weekly", label: "Weekly" },
  { value: "fortnightly", label: "Fortnightly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "annually", label: "Annually" },
] as const;

export function isLiabilityAccountType(
  accountType: string | null | undefined,
): boolean {
  if (!accountType) return false;
  return LIABILITY_ACCOUNT_TYPE_VALUES.includes(
    accountType.toLowerCase() as (typeof LIABILITY_ACCOUNT_TYPE_VALUES)[number],
  );
}

export function getAccountTypeLabel(value: string): string {
  return ACCOUNT_TYPES.find((type) => type.value === value)?.label || value;
}
