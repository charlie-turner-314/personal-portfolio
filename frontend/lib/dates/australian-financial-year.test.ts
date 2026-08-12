import { describe, expect, it } from "vitest";
import {
  formatAustralianFinancialYearLabel,
  getAustralianFinancialYearForDate,
  getAustralianFinancialYearLocalDateRange,
  getAustralianFinancialYearLabelForDateRange,
  getAustralianFinancialYearPresetDateRanges,
  getAustralianFinancialYearRange,
  getAustralianFinancialYearStartYear,
  getAustralianFinancialYearUtcInterval,
  getPreviousAustralianFinancialYearForDate,
} from "./australian-financial-year";

describe("Australian financial-year utilities", () => {
  it("labels financial years as FY2025-26", () => {
    expect(formatAustralianFinancialYearLabel(2025)).toBe("FY2025-26");
  });

  it("resolves 30 June into the prior financial year", () => {
    expect(getAustralianFinancialYearStartYear(new Date("2026-06-30T13:59:59.999Z"))).toBe(2025);
    expect(getAustralianFinancialYearForDate(new Date("2026-06-30T12:00:00.000Z"))).toEqual({
      startYear: 2025,
      label: "FY2025-26",
      startDate: "2025-07-01",
      endDate: "2026-06-30",
    });
  });

  it("resolves 1 July into the new financial year", () => {
    expect(getAustralianFinancialYearStartYear(new Date("2026-06-30T14:00:00.000Z"))).toBe(2026);
    expect(getAustralianFinancialYearForDate(new Date("2026-07-01T00:00:00.000Z"))).toEqual({
      startYear: 2026,
      label: "FY2026-27",
      startDate: "2026-07-01",
      endDate: "2027-06-30",
    });
  });

  it("keeps leap-year financial years as date-only boundaries", () => {
    expect(getAustralianFinancialYearRange(2019)).toEqual({
      startYear: 2019,
      label: "FY2019-20",
      startDate: "2019-07-01",
      endDate: "2020-06-30",
    });
  });

  it("returns timezone-safe UTC query endpoints", () => {
    const interval = getAustralianFinancialYearUtcInterval(2025);

    expect(interval.start.toISOString()).toBe("2025-07-01T00:00:00.000Z");
    expect(interval.end.toISOString()).toBe("2026-06-30T23:59:59.999Z");
  });

  it("returns local Date objects for date picker presets without ISO conversion", () => {
    const range = getAustralianFinancialYearLocalDateRange(2025);

    expect(range.label).toBe("FY2025-26");
    expect(range.from.getFullYear()).toBe(2025);
    expect(range.from.getMonth()).toBe(6);
    expect(range.from.getDate()).toBe(1);
    expect(range.to.getFullYear()).toBe(2026);
    expect(range.to.getMonth()).toBe(5);
    expect(range.to.getDate()).toBe(30);
  });

  it("builds current and previous preset labels from the reference date", () => {
    const presets = getAustralianFinancialYearPresetDateRanges(
      new Date("2026-08-12T00:00:00.000Z"),
    );

    expect(presets.map((preset) => preset.label)).toEqual([
      "This FY (FY2026-27)",
      "Last FY (FY2025-26)",
    ]);
  });

  it("recognizes exact financial-year date ranges for display", () => {
    expect(getAustralianFinancialYearLabelForDateRange(
      new Date(2025, 6, 1),
      new Date(2026, 5, 30),
    )).toBe("FY2025-26");
    expect(getAustralianFinancialYearLabelForDateRange(
      new Date(2025, 6, 2),
      new Date(2026, 5, 30),
    )).toBeNull();
  });

  it("returns the previous financial year for a reference date", () => {
    expect(getPreviousAustralianFinancialYearForDate(new Date("2026-06-30T00:00:00.000Z"))).toEqual({
      startYear: 2024,
      label: "FY2024-25",
      startDate: "2024-07-01",
      endDate: "2025-06-30",
    });
  });
});
