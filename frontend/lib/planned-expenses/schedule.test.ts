import { describe, expect, it } from "vitest";
import {
  calculateMonthlyProvision,
  generateOccurrences,
  recurrenceIntervalMonths,
  type PlannedExpenseScheduleInput,
} from "./schedule";

const expense = (
  patch: Partial<PlannedExpenseScheduleInput> = {}
): PlannedExpenseScheduleInput => ({
  id: "expense-1",
  name: "Insurance",
  amount: 1200,
  recurrenceType: "annual",
  customIntervalMonths: null,
  dueDate: "2026-12-31",
  sinkingFundTargetAmount: 1200,
  sinkingFundStartDate: "2026-01-01",
  ...patch,
});

describe("recurrenceIntervalMonths", () => {
  it("maps supported recurrence types to month intervals", () => {
    expect(recurrenceIntervalMonths("monthly")).toBe(1);
    expect(recurrenceIntervalMonths("quarterly")).toBe(3);
    expect(recurrenceIntervalMonths("annual")).toBe(12);
    expect(recurrenceIntervalMonths("one_off")).toBeNull();
    expect(recurrenceIntervalMonths("custom", 18)).toBe(18);
  });

  it("rejects invalid custom intervals", () => {
    expect(recurrenceIntervalMonths("custom", 0)).toBeNull();
    expect(recurrenceIntervalMonths("custom", 121)).toBeNull();
    expect(recurrenceIntervalMonths("custom", 2.5)).toBeNull();
  });
});

describe("generateOccurrences", () => {
  it("generates annual, quarterly, monthly, custom, and one-off occurrences", () => {
    expect(
      generateOccurrences(expense({ recurrenceType: "annual" }), "2026-01-01", "2027-12-31")
        .map((item) => item.dueDate)
    ).toEqual(["2026-12-31", "2027-12-31"]);

    expect(
      generateOccurrences(
        expense({ recurrenceType: "quarterly", dueDate: "2026-02-15" }),
        "2026-01-01",
        "2026-08-31"
      ).map((item) => item.dueDate)
    ).toEqual(["2026-02-15", "2026-05-15", "2026-08-15"]);

    expect(
      generateOccurrences(
        expense({ recurrenceType: "monthly", dueDate: "2026-01-10" }),
        "2026-03-01",
        "2026-05-31"
      ).map((item) => item.dueDate)
    ).toEqual(["2026-03-10", "2026-04-10", "2026-05-10"]);

    expect(
      generateOccurrences(
        expense({
          recurrenceType: "custom",
          customIntervalMonths: 4,
          dueDate: "2026-01-20",
        }),
        "2026-01-01",
        "2026-12-31"
      ).map((item) => item.dueDate)
    ).toEqual(["2026-01-20", "2026-05-20", "2026-09-20"]);

    expect(
      generateOccurrences(
        expense({ recurrenceType: "one_off", dueDate: "2026-07-01" }),
        "2026-01-01",
        "2026-12-31"
      ).map((item) => item.dueDate)
    ).toEqual(["2026-07-01"]);
  });

  it("clamps month-end dates including leap years", () => {
    expect(
      generateOccurrences(
        expense({ recurrenceType: "monthly", dueDate: "2024-01-31" }),
        "2024-01-01",
        "2024-03-31"
      ).map((item) => item.dueDate)
    ).toEqual(["2024-01-31", "2024-02-29", "2024-03-31"]);

    expect(
      generateOccurrences(
        expense({ recurrenceType: "monthly", dueDate: "2025-01-31" }),
        "2025-01-01",
        "2025-03-31"
      ).map((item) => item.dueDate)
    ).toEqual(["2025-01-31", "2025-02-28", "2025-03-31"]);
  });
});

describe("calculateMonthlyProvision", () => {
  it("spreads one-off expenses across inclusive sinking-fund months", () => {
    expect(
      calculateMonthlyProvision(
        expense({
          recurrenceType: "one_off",
          dueDate: "2026-12-15",
          sinkingFundStartDate: "2026-01-01",
          sinkingFundTargetAmount: 1200,
        }),
        "2026-06"
      )
    ).toBe(100);
  });

  it("requires the full remaining one-off amount once due or overdue", () => {
    expect(
      calculateMonthlyProvision(
        expense({
          recurrenceType: "one_off",
          dueDate: "2026-03-15",
          sinkingFundStartDate: "2026-01-01",
          sinkingFundTargetAmount: 1200,
        }),
        "2026-03",
        250
      )
    ).toBe(950);
  });

  it("uses recurrence intervals for recurring expenses", () => {
    expect(calculateMonthlyProvision(expense({ recurrenceType: "annual" }), "2026-05")).toBe(100);
    expect(calculateMonthlyProvision(expense({ recurrenceType: "quarterly" }), "2026-05")).toBe(400);
    expect(calculateMonthlyProvision(expense({ recurrenceType: "monthly" }), "2026-05")).toBe(1200);
    expect(
      calculateMonthlyProvision(
        expense({ recurrenceType: "custom", customIntervalMonths: 6 }),
        "2026-05"
      )
    ).toBe(200);
  });
});
