import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AssetsTable } from "./assets-table";

describe("AssetsTable", () => {
  it("renders included and excluded superannuation as separate disclosures", () => {
    render(
      <AssetsTable
        currency="AUD"
        categories={[]}
        superannuation={{
          includedValue: 120_000,
          excludedValue: 80_000,
          includedAccounts: [{
            id: "included-super",
            name: "AustralianSuper",
            institution: "Balanced",
            value: 120_000,
            percentage: 100,
            currency: "AUD",
            initial: "A",
          }],
          excludedAccounts: [{
            id: "excluded-super",
            name: "Hostplus",
            institution: "Indexed Balanced",
            value: 80_000,
            percentage: 100,
            currency: "AUD",
            initial: "H",
          }],
        }}
      />,
    );

    expect(screen.getByText("Superannuation")).toBeInTheDocument();
    expect(screen.getByText("Included in net worth")).toBeInTheDocument();
    expect(screen.getByText("Excluded from net worth")).toBeInTheDocument();
    expect(screen.getByText("AustralianSuper")).toBeInTheDocument();
    expect(screen.getByText("Hostplus")).toBeInTheDocument();
  });
});
