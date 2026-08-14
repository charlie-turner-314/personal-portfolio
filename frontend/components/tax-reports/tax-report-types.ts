export type TaxReportAmount = {
  label: string;
  amount: string | null;
  currency: string;
  sourceCount?: number;
  sourceHref?: string;
  status?: "recorded" | "classified" | "unclassified" | "unavailable";
};

export type TaxReportCgt = {
  grossGains: TaxReportAmount;
  capitalLosses: TaxReportAmount;
  discountedGains: TaxReportAmount;
  netCapitalGain: TaxReportAmount;
};

export type TaxReportSource = {
  label: string;
  count: number;
  href?: string;
};

export type TaxReportWarning = {
  id: string;
  title: string;
  detail: string;
  kind: "missing-data" | "excluded" | "review";
};

export type AustralianTaxReport = {
  financialYearStart: number;
  income: TaxReportAmount[];
  cgt: TaxReportCgt;
  interest: TaxReportAmount[];
  rental: TaxReportAmount[];
  investmentFees: TaxReportAmount[];
  deductibleExpenses: TaxReportAmount[];
  unclassifiedExpenses: TaxReportAmount[];
  cashflow: TaxReportAmount[];
  sources?: TaxReportSource[];
  warnings?: TaxReportWarning[];
  assumptions?: string[];
};
