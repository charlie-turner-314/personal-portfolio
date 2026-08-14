import { describe, expect, it } from "vitest";
import {
  calculateSuperCapProgress,
  isSuperContributionKind,
} from "./cap-progress";

describe("superannuation cap progress", () => {
  it("classifies contribution kinds into the correct caps", () => {
    const result = calculateSuperCapProgress([
      { date: "2025-07-01", amount: 12_000, kind: "employer_sg" },
      { date: "2026-01-15", amount: "5000.00", kind: "salary_sacrifice" },
      { date: "2026-05-10", amount: 3_000, kind: "personal_concessional" },
      { date: "2026-06-01", amount: 20_000, kind: "personal_non_concessional" },
      { date: "2026-06-15", amount: 500, kind: "fee" },
      { date: "2026-06-20", amount: 250, kind: "insurance" },
    ], 2025, { concessionalCap: 30_000, nonConcessionalCap: 120_000 });

    expect(result.financialYear.label).toBe("FY2025-26");
    expect(result.concessional).toEqual({ used: 20_000, cap: 30_000, remaining: 10_000, configured: true });
    expect(result.nonConcessional).toEqual({ used: 20_000, cap: 120_000, remaining: 100_000, configured: true });
  });

  it("uses Australian FY boundaries for 30 June and 1 July", () => {
    const result = calculateSuperCapProgress([
      { date: "2026-06-30", amount: 1_000, kind: "employer_sg" },
      { date: "2026-07-01", amount: 2_000, kind: "employer_sg" },
    ], 2025, { concessionalCap: 30_000, nonConcessionalCap: null });

    expect(result.concessional.used).toBe(1_000);
    expect(calculateSuperCapProgress([
      { date: "2026-06-30", amount: 1_000, kind: "employer_sg" },
      { date: "2026-07-01", amount: 2_000, kind: "employer_sg" },
    ], 2026, { concessionalCap: 30_000, nonConcessionalCap: null }).concessional.used).toBe(2_000);
  });

  it("reports an explicit unconfigured state when no cap has been saved", () => {
    const result = calculateSuperCapProgress([
      { date: "2025-07-01", amount: 2_000, kind: "employer_sg" },
    ], 2025, null);

    expect(result.concessional).toEqual({ used: 2_000, cap: null, remaining: null, configured: false });
    expect(result.nonConcessional).toEqual({ used: 0, cap: null, remaining: null, configured: false });
  });

  it("rejects malformed dates, amounts, and persisted kinds from progress", () => {
    expect(isSuperContributionKind("unexpected_kind")).toBe(false);
    const result = calculateSuperCapProgress([
      { date: "2025-02-30", amount: 1_000, kind: "employer_sg" },
      { date: "2025-07-01", amount: -1_000, kind: "employer_sg" },
    ], 2025, { concessionalCap: "not-a-number", nonConcessionalCap: null });

    expect(result.concessional).toEqual({ used: 0, cap: null, remaining: null, configured: false });
  });
});
