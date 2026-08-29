import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TransactionsQueryState } from "@/lib/transactions/query-state";
import { TransactionsClient } from "@/app/(dashboard)/transactions/transactions-client";

const { mockPush, mockRegisterCallbacks } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockRegisterCallbacks: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/command-palette-context", () => ({
  useRegisterCommandPaletteCallbacks: mockRegisterCallbacks,
}));

vi.mock("@/components/transactions/transaction-table", () => ({
  TransactionTable: ({ action }: { action: React.ReactNode }) => <div>{action}</div>,
}));

vi.mock("@/components/transactions/add-transaction-dialog", () => ({
  AddTransactionDialog: ({ open }: { open: boolean }) => (
    <div data-testid="add-transaction-dialog" data-open={open} />
  ),
}));

vi.mock("@/lib/hooks/use-import-status", () => ({
  useImportStatus: () => ({
    isImporting: false,
    progress: null,
    processedRows: null,
    totalRows: null,
  }),
  getPendingImport: () => null,
  clearPendingImport: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "user-1" } } }),
}));

vi.mock("@/lib/utils/csv-export", () => ({
  exportTransactionsToCSV: vi.fn(),
}));

function renderClient(canImportCsv = true) {
  return render(
    <TransactionsClient
      initialTransactions={[]}
      totalCount={0}
      filteredTotals={null}
      initialQueryState={{} as TransactionsQueryState}
      categories={[]}
      accounts={[]}
      properties={[]}
      canImportCsv={canImportCsv}
    />
  );
}

describe("TransactionsClient entry actions", () => {
  it("routes the visible import action to the existing CSV import workflow", () => {
    renderClient();

    fireEvent.click(screen.getByRole("button", { name: "Import transactions" }));

    expect(mockPush).toHaveBeenCalledWith("/transactions/import");
  });

  it("keeps the command-palette import callback registered when import UI is restricted", () => {
    renderClient(false);

    const callbacks = mockRegisterCallbacks.mock.calls.at(-1)?.[0];
    expect(callbacks.onImportCsv).toEqual(expect.any(Function));
    callbacks.onImportCsv();
    expect(mockPush).toHaveBeenCalledWith("/transactions/import");
  });

  it("keeps Add Transaction wired to manual entry", () => {
    renderClient();

    fireEvent.click(screen.getByRole("button", { name: "Add Transaction" }));

    expect(screen.getByTestId("add-transaction-dialog")).toHaveAttribute(
      "data-open",
      "true"
    );
  });
});
