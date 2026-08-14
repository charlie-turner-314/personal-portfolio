import { describe, expect, it } from "vitest";
import {
  FALLBACK_REGIONAL_DEFAULTS,
  getCountryDefaults,
  inferCountryCodeFromProfile,
  isSupportedCountryCode,
  isSupportedLocaleCode,
} from "./locales";

describe("locale constants", () => {
  it("defaults Australia to AUD and en-AU", () => {
    expect(getCountryDefaults("AU")).toMatchObject({
      code: "AU",
      defaultCurrency: "AUD",
      defaultLocale: "en-AU",
    });
  });

  it("keeps unknown countries on the neutral EUR fallback", () => {
    expect(getCountryDefaults("ZZ")).toEqual(FALLBACK_REGIONAL_DEFAULTS);
  });

  it("infers Australia from explicit AUD, en-AU, or an Australian timezone", () => {
    expect(inferCountryCodeFromProfile({ functionalCurrency: "AUD" })).toBe("AU");
    expect(inferCountryCodeFromProfile({ locale: "en-AU" })).toBe("AU");
    expect(inferCountryCodeFromProfile({ timeZone: "Australia/Brisbane" })).toBe("AU");
  });

  it("does not infer Australia for unknown profile data", () => {
    expect(inferCountryCodeFromProfile({})).toBe(FALLBACK_REGIONAL_DEFAULTS.code);
  });

  it("validates country and locale values", () => {
    expect(isSupportedCountryCode("AU")).toBe(true);
    expect(isSupportedCountryCode("ZZ")).toBe(false);
    expect(isSupportedLocaleCode("en-AU")).toBe(true);
    expect(isSupportedLocaleCode("en-ZZ")).toBe(false);
  });
});
