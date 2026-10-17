import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/db/schema";
import { LIABILITY_ACCOUNT_TYPE_VALUES } from "@/lib/constants/account-types";
import { AccountHeader } from "./account-header";

vi.mock("@/components/ui/account-logo", () => ({ AccountLogo: () => null }));
vi.mock("./account-freshness", () => ({ AccountFreshnessIndicator: () => null }));

for (const accountType of LIABILITY_ACCOUNT_TYPE_VALUES) {
  describe(`${accountType} balance display`, () => {
    it.each([1250, -1250])("shows stored %s as a negative amount owed", (balance) => {
      render(<AccountHeader account={{ id: "debt", name: "Debt", accountType, functionalBalance: String(balance) } as Account}
        currency="AUD" freshness={{ source: "manual", status: "manual", lastUpdatedAt: null, dataThrough: null }} />);
      expect(screen.getByText(/-A\$1,250\.00/)).toHaveClass("text-red-600");
      expect(screen.getByText("Balance owed")).toBeInTheDocument();
    });
  });
}
