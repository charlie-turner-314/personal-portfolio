export type CgtCalculationStatus = "complete" | "partial" | "unavailable";

export type CgtAllocation = {
  id: string;
  acquisition_date: string;
  quantity: string;
  cost_base: string | null;
  proceeds: string | null;
  capital_gain: string | null;
  currency: string;
  discount_eligible: boolean | null;
  assumptions?: string[];
};

export type RealisedCgtDisposal = {
  id: string;
  disposal_date: string;
  quantity: string;
  cost_base: string | null;
  proceeds: string | null;
  capital_gain: string | null;
  currency: string;
  calculation_status: CgtCalculationStatus;
  allocations: CgtAllocation[];
  assumptions?: string[];
  unavailable_reason?: string | null;
};

export type CgtFinancialYearSummary = {
  financial_year_start_year: number;
  currency: string;
  gross_capital_gains: string | null;
  capital_losses: string | null;
  discounted_gains: string | null;
  net_capital_gain: string | null;
  disposal_count: number;
  calculation_status: CgtCalculationStatus;
  assumptions?: string[];
  unavailable_reason?: string | null;
};
