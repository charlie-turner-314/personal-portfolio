import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TransactionsQueryState } from "@/lib/transactions/query-state";
import { TransactionsSection } from "@/app/(dashboard)/transactions/_sections";

const { mockIsDemoRestrictedUserEmail } = vi.hoisted(() => ({
  mockIsDemoRestrictedUserEmail: vi.fn(),
}));

vi.mock("@/app/(dashboard)/transactions/transactions-client", () => ({
  TransactionsClient: ({ canImportCsv }: { canImportCsv: boolean }) => (
    <div data-testid="transactions-client" data-can-import-csv={canImportCsv} />
  ),
}));

vi.mock("@/lib/actions/transactions", () => ({
  getTransactionsPage: vi.fn().mockResolvedValue({
    rows: [],
    totalCount: 0,
    filteredTotals: null,
  }),
  getUserAccounts: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/actions/categories", () => ({
  getUserCategories: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/actions/properties", () => ({
  getProperties: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/auth-helpers", () => ({
  getAuthenticatedSession: vi.fn().mockResolvedValue({ user: { email: "user@example.com" } }),
}));

vi.mock("@/lib/demo-access", () => ({
  isDemoRestrictedUserEmail: mockIsDemoRestrictedUserEmail,
}));

describe("TransactionsSection", () => {
  it("allows CSV import without an OpenAI API key for non-demo users", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    mockIsDemoRestrictedUserEmail.mockReturnValue(false);

    render(await TransactionsSection({ queryState: {} as TransactionsQueryState }));

    expect(screen.getByTestId("transactions-client")).toHaveAttribute(
      "data-can-import-csv",
      "true"
    );
  });

  it("continues to restrict CSV import for demo users", async () => {
    mockIsDemoRestrictedUserEmail.mockReturnValue(true);

    render(await TransactionsSection({ queryState: {} as TransactionsQueryState }));

    expect(screen.getByTestId("transactions-client")).toHaveAttribute(
      "data-can-import-csv",
      "false"
    );
  });
});
