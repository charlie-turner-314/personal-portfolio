import { describe, expect, it } from "vitest";
import {
  DEFAULT_CATEGORIES,
  getDefaultCategoriesForCountry,
} from "./default-categories";

describe("getDefaultCategoriesForCountry", () => {
  it("uses Australian merchant examples for Australian users", () => {
    const categories = getDefaultCategoriesForCountry("AU");

    expect(categories.find((category) => category.name === "Groceries")?.description)
      .toContain("Woolworths");
    expect(categories.find((category) => category.name === "Transport")?.description)
      .toContain("Opal");
    expect(categories.find((category) => category.name === "Investment Income")?.description)
      .toContain("franking credits");
    expect(categories.find((category) => category.name === "Bills & Utilities")?.categorizationInstructions)
      .toContain("Telstra");
  });

  it("keeps the existing generic defaults for non-Australian users", () => {
    expect(getDefaultCategoriesForCountry("US")).toBe(DEFAULT_CATEGORIES);
  });
});
