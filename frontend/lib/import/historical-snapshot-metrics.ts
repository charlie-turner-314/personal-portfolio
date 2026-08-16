export type HistoricalMetricKey =
  | "netWorth" | "cash" | "stocks" | "etfs" | "crypto" | "managedFunds" | "investments" | "superannuation"
  | "propertyValue" | "propertyPurchaseValue" | "propertyMortgage" | "propertyNetEquity"
  | "mortgageInterestFees" | "mortgagePrincipalPaid" | "salaryIncome" | "gains" | "movements"
  | "vehicles" | "otherAssets" | "personalLoans" | "creditCards" | "otherLiabilities";

export const HISTORICAL_METRICS: Array<{ key: HistoricalMetricKey; label: string; aliases: string[]; kind: "asset" | "liability" | "netWorth" | "informational" }> = [
  { key: "netWorth", label: "Net worth", aliases: ["net worth", "networth", "total net worth"], kind: "netWorth" },
  { key: "cash", label: "Cash", aliases: ["cash", "cash accounts", "bank balance"], kind: "asset" },
  { key: "stocks", label: "Stocks", aliases: ["stocks", "shares", "share value"], kind: "asset" },
  { key: "etfs", label: "ETFs", aliases: ["etfs", "etf", "exchange traded funds"], kind: "asset" },
  { key: "crypto", label: "Crypto", aliases: ["crypto", "cryptocurrency", "digital assets"], kind: "asset" },
  { key: "managedFunds", label: "Managed funds", aliases: ["managed funds", "managed fund"], kind: "asset" },
  { key: "investments", label: "Investments", aliases: ["investments", "investment accounts", "shares"], kind: "asset" },
  { key: "superannuation", label: "Superannuation", aliases: ["super", "superannuation", "retirement"], kind: "asset" },
  { key: "propertyValue", label: "Property value", aliases: ["property value", "real estate"], kind: "asset" },
  { key: "propertyPurchaseValue", label: "Property purchase value", aliases: ["property purchase value", "purchase value", "property cost"], kind: "informational" },
  { key: "propertyMortgage", label: "Property mortgage", aliases: ["mortgage", "property mortgage", "home loan"], kind: "liability" },
  { key: "propertyNetEquity", label: "Property net equity", aliases: ["property net equity", "property equity", "home equity"], kind: "asset" },
  { key: "mortgageInterestFees", label: "Mortgage interest and fees", aliases: ["mortgage interest", "interest and fees", "mortgage fees"], kind: "informational" },
  { key: "mortgagePrincipalPaid", label: "Mortgage principal paid", aliases: ["mortgage principal paid", "principal paid"], kind: "informational" },
  { key: "salaryIncome", label: "Salary income", aliases: ["salary income", "salary", "income"], kind: "informational" },
  { key: "gains", label: "Gains", aliases: ["gains", "investment gains", "capital gains"], kind: "informational" },
  { key: "movements", label: "Movements", aliases: ["movements", "movement", "net movement"], kind: "informational" },
  { key: "vehicles", label: "Vehicles", aliases: ["vehicles", "vehicle value", "cars"], kind: "asset" },
  { key: "otherAssets", label: "Other assets", aliases: ["other assets"], kind: "asset" },
  { key: "personalLoans", label: "Personal loans", aliases: ["personal loans", "personal loan"], kind: "liability" },
  { key: "creditCards", label: "Credit cards", aliases: ["credit cards", "credit card"], kind: "liability" },
  { key: "otherLiabilities", label: "Other liabilities", aliases: ["other liabilities"], kind: "liability" },
];

export function calculateHistoricalNetWorth(values: Partial<Record<HistoricalMetricKey, number>>) {
  if (values.netWorth !== undefined) return values.netWorth;
  let assets = 0; let liabilities = 0;
  for (const metric of HISTORICAL_METRICS) {
    const value = values[metric.key]; if (value === undefined || metric.key === "netWorth") continue;
    // Equity is already property value less mortgage. Prefer it whenever it is
    // present; otherwise use the separately supplied property components.
    if ((metric.key === "propertyValue" || metric.key === "propertyMortgage") && values.propertyNetEquity !== undefined) continue;
    if (metric.kind === "asset") assets += value;
    if (metric.kind === "liability") liabilities += Math.abs(value);
  }
  return assets - liabilities;
}
