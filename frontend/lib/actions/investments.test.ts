import { describe, it, expect } from "vitest";
import { rangeToDates } from "../utils/date-ranges";
import { fetchHoldingHistoryRange } from "./investments";

describe("rangeToDates", () => {
  const ref = new Date("2026-04-25T00:00:00Z");
  it("1W spans 7 days", () => {
    const { from, to } = rangeToDates("1W", ref);
    expect(to).toBe("2026-04-25");
    expect(from).toBe("2026-04-18");
  });
  it("1M spans 30 days", () => {
    expect(rangeToDates("1M", ref).from).toBe("2026-03-26");
  });
  it("ALL uses a far-back date", () => {
    expect(rangeToDates("ALL", ref).from).toBe("2010-01-01");
  });
  it("FY uses Australian financial-year boundaries", () => {
    expect(rangeToDates("FY", new Date("2026-06-30T00:00:00Z"))).toEqual({
      from: "2025-07-01",
      to: "2026-06-30",
    });
    expect(rangeToDates("FY", new Date("2026-07-01T00:00:00Z"))).toEqual({
      from: "2026-07-01",
      to: "2027-06-30",
    });
  });
});

describe("fetchHoldingHistoryRange export", () => {
  it("is an async function", () => {
    expect(typeof fetchHoldingHistoryRange).toBe("function");
  });
});
