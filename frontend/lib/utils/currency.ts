const SYMBOLS: Record<string, string> = {
  AUD: "A$",
  USD: "$",
  EUR: "€",
  GBP: "£",
};

export function currencySymbol(code: string): string {
  const upper = code.toUpperCase();
  return SYMBOLS[upper] ?? upper;
}

export const INVESTMENT_CURRENCIES = ["AUD", "USD", "EUR", "GBP", "NZD", "CAD", "JPY", "CHF", "HKD", "SGD"] as const;
