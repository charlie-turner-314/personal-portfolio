import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getTransactionsPage } from "@/lib/actions/transactions";
import { parseTransactionsSearchParams } from "@/lib/transactions/query-state";
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
  getReportingCategories: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/actions/properties", () => ({
  getProperties: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/household/financial-auth", () => ({
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
  it("shows a recoverable unavailable selection without fetching misleading zero totals",async()=>{
    vi.mocked(getTransactionsPage).mockClear();
    const queryState=parseTransactionsSearchParams({account:"withdrawn-account",person:"all",from:"2026-01-01",to:"2026-01-31"});
    render(await TransactionsSection({queryState}));
    expect(screen.getByRole("alert")).toHaveTextContent("cannot be calculated");
    const href=screen.getByRole("link",{name:"Clear account filter"}).getAttribute("href")!;
    const params=new URLSearchParams(href.split("?")[1]);
    expect(params.get("person")).toBe("all");expect(params.get("from")).toBe("2026-01-01");expect(params.has("account")).toBe(false);
    expect(getTransactionsPage).not.toHaveBeenCalled();
  });

});
