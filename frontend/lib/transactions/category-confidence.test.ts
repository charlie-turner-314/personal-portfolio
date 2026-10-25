import { describe, expect, it } from "vitest";
import { categoryConfidenceLabel } from "./category-confidence";
import { parseTransactionsSearchParamsFromUrlSearchParams, toTransactionsSearchParams } from "./query-state";

describe("category confidence review", () => {
  const automatic = { categoryId: null, categorySystemId: "groceries" };
  it("shows recorded scores including zero", () => {
    expect(categoryConfidenceLabel({ ...automatic, categoryConfidence: 0 })).toBe("0%");
    expect(categoryConfidenceLabel({ ...automatic, categoryConfidence: 82 })).toBe("82%");
  });
  it("does not invent confidence for legacy or invalid scores", () => {
    for (const categoryConfidence of [null, undefined, NaN, -1, 101]) {
      expect(categoryConfidenceLabel({ ...automatic, categoryConfidence })).toBe("Not scored");
    }
  });
  it("manual corrections take precedence over the old automatic score", () => {
    expect(categoryConfidenceLabel({ ...automatic, categoryId: "gifts", categoryConfidence: 12 })).toBe("Manually categorised");
    expect(categoryConfidenceLabel({ categoryId: null, categorySystemId: null, categoryConfidence: 90 })).toBe("Uncategorised");
  });
  it("preserves confidence sorting and filters in pagination URLs", () => {
    const state = parseTransactionsSearchParamsFromUrlSearchParams(new URLSearchParams("sort=categoryConfidence&order=asc&page=3&category=groceries"));
    expect(state.sort).toBe("categoryConfidence");
    expect(state.order).toBe("asc");
    const roundTrip = parseTransactionsSearchParamsFromUrlSearchParams(toTransactionsSearchParams(state));
    expect(roundTrip).toEqual(state);
  });
});
