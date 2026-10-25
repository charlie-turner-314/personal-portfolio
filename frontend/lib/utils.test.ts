import { describe, expect, it } from "vitest";
import { formatAmount } from "./utils";

describe("transaction amount formatting", () => {
  it("uses decimal points and grouping for signed amounts", () => {
    expect(formatAmount(-1234.56, "AUD")).toBe("-$1,234.56");
    expect(formatAmount(12.5, "EUR")).toBe("EUR\u00a012.50");
    expect(formatAmount(0, "AUD")).toBe("$0.00");
  });
});
