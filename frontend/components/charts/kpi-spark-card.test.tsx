import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KpiSparkCard } from "./kpi-spark-card";

describe("signed dashboard balances", () => {
  it("shows liabilities as a negative red balance owed", () => {
    render(<KpiSparkCard title="Total Liabilities" value={-1500} currency="AUD"
      subtitle="Balance owed · included in net worth" sparkData={[]} showSign valueTone="liability" />);
    expect(screen.getByText("-A$1,500")).toHaveClass("text-red-600");
    expect(screen.getByText(/Balance owed/)).toBeInTheDocument();
  });

  it("preserves an overdrawn cash total's minus sign", () => {
    render(<KpiSparkCard title="Total Cash" value={-250} currency="AUD"
      subtitle="Bank and cash accounts · net of overdrafts" sparkData={[]} showSign />);
    expect(screen.getByText("-A$250")).toBeInTheDocument();
  });
});
