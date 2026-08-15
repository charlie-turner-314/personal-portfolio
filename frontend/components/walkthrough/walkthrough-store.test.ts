import { describe, expect, it } from "vitest";
import { getPageConfig } from "./walkthrough-store";

describe("budget walkthrough", () => {
  it("provides short budget guidance on the budget route", () => {
    expect(getPageConfig("/budget")).toMatchObject({
      page: "budget",
      steps: [
        { target: "walkthrough-budget-plan" },
        { target: "walkthrough-budget-future" },
      ],
    });
  });
});
