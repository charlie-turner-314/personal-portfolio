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
