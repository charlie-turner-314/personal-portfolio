import type { InvestmentImportMapping } from "@/lib/api/investments";

export const EMPTY_INVESTMENT_IMPORT_MAPPING: InvestmentImportMapping = {
  occurred_at: null,
  activity_type: null,
  asset_symbol: null,
  asset_name: null,
  asset_type: null,
  quantity: null,
  price: null,
  gross_amount: null,
  net_amount: null,
  currency: null,
  fee_amount: null,
  fee_currency: null,
  tax_amount: null,
  tax_currency: null,
  source_reference: null,
  counter_asset_symbol: null,
  counter_quantity: null,
  direction: null,
  description: null,
  ex_date: null,
  franked_amount: null,
  unfranked_amount: null,
  franking_credit: null,
  foreign_income: null,
  foreign_tax_paid: null,
  tfn_withholding: null,
  amit_amma_components: null,
  cost_base_increase: null,
  cost_base_decrease: null,
  cost_base_effective_date: null,
  annual_statement_reference: null,
  amma_interest: null,
  amma_capital_gains_discounted: null,
  amma_capital_gains_other: null,
  amma_capital_gains_discount: null,
  amma_tax_deferred: null,
  amma_tax_free: null,
  amma_other_non_assessable: null,
};

export const INVESTMENT_IMPORT_FIELDS: Array<{
  key: keyof InvestmentImportMapping;
  label: string;
  required?: boolean;
}> = [
  { key: "occurred_at", label: "Date / time", required: true },
  { key: "activity_type", label: "Activity type", required: true },
  { key: "asset_symbol", label: "Symbol / asset", required: true },
  { key: "asset_name", label: "Asset name" },
  { key: "asset_type", label: "Asset type" },
  { key: "quantity", label: "Quantity" },
  { key: "price", label: "Unit price" },
  { key: "gross_amount", label: "Gross amount" },
  { key: "net_amount", label: "Net amount" },
  { key: "currency", label: "Currency" },
  { key: "fee_amount", label: "Fee" },
  { key: "fee_currency", label: "Fee currency" },
  { key: "tax_amount", label: "Tax withheld" },
  { key: "tax_currency", label: "Tax currency" },
  { key: "source_reference", label: "Source reference" },
  { key: "counter_asset_symbol", label: "Counter asset" },
  { key: "counter_quantity", label: "Counter quantity" },
  { key: "direction", label: "Direction" },
  { key: "description", label: "Description" },
  { key: "ex_date", label: "Ex date" },
  { key: "franked_amount", label: "Franked amount" },
  { key: "unfranked_amount", label: "Unfranked amount" },
  { key: "franking_credit", label: "Franking credit" },
  { key: "foreign_income", label: "Foreign income" },
  { key: "foreign_tax_paid", label: "Foreign tax paid" },
  { key: "tfn_withholding", label: "TFN withholding" },
  { key: "amit_amma_components", label: "AMIT / AMMA components (JSON)" },
  { key: "cost_base_increase", label: "AMIT cost-base increase" },
  { key: "cost_base_decrease", label: "AMIT cost-base decrease" },
  { key: "cost_base_effective_date", label: "Cost-base effective date" },
  { key: "annual_statement_reference", label: "Annual statement reference" },
  { key: "amma_interest", label: "AMMA interest" },
  { key: "amma_capital_gains_discounted", label: "AMMA discounted capital gains" },
  { key: "amma_capital_gains_other", label: "AMMA other capital gains" },
  { key: "amma_capital_gains_discount", label: "AMMA capital gains discount" },
  { key: "amma_tax_deferred", label: "AMMA tax-deferred amount" },
  { key: "amma_tax_free", label: "AMMA tax-free amount" },
  { key: "amma_other_non_assessable", label: "AMMA other non-assessable" },
];

const HEADER_ALIASES: Record<keyof InvestmentImportMapping, string[]> = {
  occurred_at: ["date", "trade date", "transaction date", "timestamp", "time", "occurred at"],
  activity_type: ["type", "activity", "activity type", "transaction type", "side", "action"],
  asset_symbol: ["symbol", "ticker", "asset", "coin", "instrument", "code"],
  asset_name: ["asset name", "security name", "instrument name", "name"],
  asset_type: ["asset type", "instrument type", "security type"],
  quantity: ["quantity", "qty", "units", "shares", "amount"],
  price: ["price", "unit price", "trade price", "average price", "avg price"],
  gross_amount: ["gross", "gross amount", "gross value", "value"],
  net_amount: ["net", "net amount", "net value", "cash amount"],
  currency: ["currency", "ccy", "trade currency"],
  fee_amount: ["fee", "fees", "commission", "brokerage"],
  fee_currency: ["fee currency", "commission currency"],
  tax_amount: ["tax", "tax amount", "withholding tax", "tax withheld"],
  tax_currency: ["tax currency", "withholding currency"],
  source_reference: ["reference", "id", "transaction id", "trade id", "order id", "reference id"],
  counter_asset_symbol: ["counter asset", "counter currency", "quote asset"],
  counter_quantity: ["counter quantity", "quote quantity", "quote amount"],
  direction: ["direction", "transfer direction"],
  description: ["description", "details", "memo", "notes"],
  ex_date: ["ex date", "ex dividend date"],
  franked_amount: ["franked amount", "franked dividend"],
  unfranked_amount: ["unfranked amount", "unfranked dividend"],
  franking_credit: ["franking credit", "imputation credit"],
  foreign_income: ["foreign income", "foreign source income"],
  foreign_tax_paid: ["foreign tax paid", "foreign withholding tax"],
  tfn_withholding: ["tfn withholding", "tfn amount withheld"],
  amit_amma_components: ["amit amma components", "amma components", "tax components json"],
  cost_base_increase: ["amit cost base net amount shortfall", "cost base increase"],
  cost_base_decrease: ["amit cost base net amount excess", "cost base decrease"],
  cost_base_effective_date: ["cost base effective date", "amit adjustment date"],
  annual_statement_reference: ["annual statement reference", "amma statement reference"],
  amma_interest: ["amma interest", "interest income", "interest australian"],
  amma_capital_gains_discounted: ["amma discounted capital gains", "capital gains discounted"],
  amma_capital_gains_other: ["amma other capital gains", "capital gains other method"],
  amma_capital_gains_discount: ["amma capital gains discount", "capital gains discount"],
  amma_tax_deferred: ["amma tax deferred", "tax deferred amount"],
  amma_tax_free: ["amma tax free", "tax free amount"],
  amma_other_non_assessable: ["amma other non assessable", "other non assessable amount"],
};

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

export function suggestInvestmentImportMapping(headers: string[]): InvestmentImportMapping {
  const headerByNormalized = new Map(headers.map((header) => [normalized(header), header]));
  const mapping = { ...EMPTY_INVESTMENT_IMPORT_MAPPING };
  for (const field of INVESTMENT_IMPORT_FIELDS) {
    const match = HEADER_ALIASES[field.key]
      .map((alias) => headerByNormalized.get(alias))
      .find(Boolean);
    mapping[field.key] = match ?? null;
  }
  return mapping;
}

export function reconcileSavedInvestmentMapping(
  saved: InvestmentImportMapping,
  headers: string[],
): InvestmentImportMapping {
  const exact = new Set(headers);
  const folded = new Map(headers.map((header) => [header.toLowerCase(), header]));
  const result = { ...EMPTY_INVESTMENT_IMPORT_MAPPING };
  for (const field of INVESTMENT_IMPORT_FIELDS) {
    const value = saved[field.key];
    result[field.key] = value
      ? exact.has(value)
        ? value
        : folded.get(value.toLowerCase()) ?? null
      : null;
  }
  return result;
}
