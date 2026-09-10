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
