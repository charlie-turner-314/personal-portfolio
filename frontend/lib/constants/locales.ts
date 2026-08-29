export const COUNTRY_OPTIONS = [
  { code: "AU", name: "Australia", defaultCurrency: "AUD", defaultLocale: "en-AU" },
  { code: "US", name: "United States", defaultCurrency: "USD", defaultLocale: "en-US" },
  { code: "GB", name: "United Kingdom", defaultCurrency: "GBP", defaultLocale: "en-GB" },
  { code: "NL", name: "Netherlands", defaultCurrency: "EUR", defaultLocale: "en-NL" },
  { code: "DE", name: "Germany", defaultCurrency: "EUR", defaultLocale: "de-DE" },
] as const;

export const LOCALE_OPTIONS = [
  { code: "en-AU", name: "English (Australia)" },
  { code: "en-US", name: "English (United States)" },
  { code: "en-GB", name: "English (United Kingdom)" },
  { code: "en-NL", name: "English (Netherlands)" },
  { code: "de-DE", name: "German (Germany)" },
] as const;

export type CountryCode = (typeof COUNTRY_OPTIONS)[number]["code"];
export type LocaleCode = (typeof LOCALE_OPTIONS)[number]["code"];

export interface RegionalDefaults {
  code: CountryCode;
  name: string;
  defaultCurrency: string;
  defaultLocale: string;
}

export const FALLBACK_REGIONAL_DEFAULTS: RegionalDefaults = {
  code: "NL",
  name: "Netherlands",
  defaultCurrency: "EUR",
  defaultLocale: "en-NL",
};

export function isSupportedCountryCode(value: string | null | undefined): value is CountryCode {
  return COUNTRY_OPTIONS.some((country) => country.code === value);
}

export function isSupportedLocaleCode(value: string | null | undefined): value is LocaleCode {
  return LOCALE_OPTIONS.some((locale) => locale.code === value);
}

export function getCountryDefaults(countryCode: string | null | undefined): RegionalDefaults {
  return COUNTRY_OPTIONS.find((country) => country.code === countryCode) ?? FALLBACK_REGIONAL_DEFAULTS;
}

export function inferCountryCodeFromLocale(locale: string | null | undefined): CountryCode | null {
  if (!locale) return null;
  const region = locale.split("-").at(-1)?.toUpperCase();
  return isSupportedCountryCode(region) ? region : null;
}

export function inferCountryCodeFromTimeZone(timeZone: string | null | undefined): CountryCode | null {
  if (!timeZone) return null;
  if (timeZone.startsWith("Australia/")) return "AU";
  return null;
}

export function inferCountryCodeFromProfile(input: {
  countryCode?: string | null;
  functionalCurrency?: string | null;
  locale?: string | null;
  timeZone?: string | null;
}): CountryCode {
  if (isSupportedCountryCode(input.countryCode)) return input.countryCode;
  if (input.functionalCurrency === "AUD") return "AU";
  return (
    inferCountryCodeFromLocale(input.locale) ??
    inferCountryCodeFromTimeZone(input.timeZone) ??
    FALLBACK_REGIONAL_DEFAULTS.code
  );
}

export function isAustralianProfile(input: {
  countryCode?: string | null;
  functionalCurrency?: string | null;
  locale?: string | null;
  timeZone?: string | null;
}): boolean {
  return inferCountryCodeFromProfile(input) === "AU";
}
