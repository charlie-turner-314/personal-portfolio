import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  previewInvestmentImport: vi.fn(),
  applyInvestmentImport: vi.fn(),
  listInvestmentImportProfiles: vi.fn(),
  listInvestmentImports: vi.fn(),
  listInvestmentCryptoTransfers: vi.fn(),
  listInvestmentReconciliationItems: vi.fn(),
  listInvestmentIngestionSourceRecords: vi.fn(),
  confirmInvestmentCryptoTransfer: vi.fn(),
  listAccountIncomeEvents: vi.fn(),
  resolveInvestmentReconciliationItem: vi.fn(),
  revertInvestmentImport: vi.fn(),
}));

vi.mock("@/lib/api/investments", () => mocks);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/transactions/csv-upload-dropzone", () => ({
  CsvUploadDropzone: ({ onFileSelect }: { onFileSelect: (file: File, content: string) => void }) => (
    <>
      <button type="button" onClick={() => onFileSelect(
        new File(["Reference,Date,Type,Symbol,Quantity,Price,Currency\nT1,2025-01-01,Buy,VAS,2,100,AUD\n"], "statement.csv"),
        "Reference,Date,Type,Symbol,Quantity,Price,Currency\nT1,2025-01-01,Buy,VAS,2,100,AUD\n",
      )}>Choose investment CSV</button>
      <button type="button" onClick={() => {
        const content = [
          "Entity Name,Synthetic Investor",
          "Account Name,Synthetic Superhero Account",
          "Transaction Statement (AUS)",
          "Transaction Date,Settlement Date,Security,Security Code,Transaction Type,Quantity,Average Price,Net Amount,Brokerage,GST,Tax",
          "14/09/2024,16/09/2024,Example Holdings,EXM,Buy,50,$6.47,-$323.50,$5.00,$0.45,$0.00",
        ].join("\n");
        onFileSelect(new File([content], "superhero.csv"), content);
      }}>Choose Superhero CSV</button>
    </>
  ),
}));

import { InvestmentImportWizard } from "./InvestmentImportWizard";

const accounts = [{ id: "account-1", name: "Brokerage", base_currency: "AUD", source: "manual" as const }];
const preview = {
  provider: "generic",
  file_name: "statement.csv",
  source_hash: "a".repeat(64),
  headers: ["Reference", "Date", "Type", "Symbol", "Quantity", "Price", "Currency"],
  resolved_amount_format: "DOT_DECIMAL",
  rows: [{
    row_number: 2,
    status: "ready" as const,
    asset_status: "new" as const,
    normalized: { occurred_at: "2025-01-01T00:00:00", activity_type: "buy", asset_symbol: "VAS", quantity: "2", price: "100", currency: "AUD" },
    warnings: [],
    raw: {},
  }],
  rejected_rows: [],
  unmatched_assets: ["VAS"],
  summary: { total_rows: 1, ready_rows: 1, duplicate_rows: 0, rejected_rows: 0, conflict_rows: 0, warning_rows: 0 },
};

describe("InvestmentImportWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listInvestmentImports.mockResolvedValue([]);
    mocks.listInvestmentCryptoTransfers.mockResolvedValue([]);
    mocks.listInvestmentImportProfiles.mockResolvedValue([]);
    mocks.listInvestmentReconciliationItems.mockResolvedValue([]);
    mocks.listAccountIncomeEvents.mockResolvedValue([]);
    mocks.resolveInvestmentReconciliationItem.mockResolvedValue({});
    mocks.listInvestmentIngestionSourceRecords.mockResolvedValue([]);
    mocks.confirmInvestmentCryptoTransfer.mockResolvedValue({});
    mocks.previewInvestmentImport.mockResolvedValue(preview);
    mocks.applyInvestmentImport.mockResolvedValue({ run_id: "run-1", inserted_records: 1, skipped_duplicate_records: 0, inserted_activities: 1 });
    mocks.revertInvestmentImport.mockResolvedValue({ run_id: "run-1", status: "reverted", removed_trades: 1, removed_income_events: 0 });
  });

  it("maps, previews, and applies a generic statement with visible new-asset status", async () => {
    render(<InvestmentImportWizard accounts={accounts} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose investment CSV" }));
    const previewButton = screen.getByRole("button", { name: /preview import/i });
    await waitFor(() => expect(previewButton).toHaveProperty("disabled", false));
    fireEvent.click(previewButton);

    expect(await screen.findByText("Dry-run preview", { exact: false })).toBeTruthy();
    expect(screen.getByText("VAS · new")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /import 1 ready row/i }));

    await waitFor(() => expect(mocks.applyInvestmentImport).toHaveBeenCalledWith(expect.objectContaining({
      account_id: "account-1",
      provider: "generic",
      file_name: "statement.csv",
      save_mapping: true,
      mapping: expect.objectContaining({ occurred_at: "Date", activity_type: "Type", asset_symbol: "Symbol" }),
    })));
    expect(await screen.findByText(/Imported 1 activity/)).toBeTruthy();
  });

  it("shows history and can undo one completed batch", async () => {
    mocks.listInvestmentImports.mockResolvedValueOnce([{
      id: "run-1",
      account_id: "account-1",
      provider: "generic",
      status: "completed",
      source_name: "statement.csv",
      summary: { inserted_activities: 2 },
      warnings: [],
      error: null,
      started_at: "2025-01-01T00:00:00Z",
      completed_at: "2025-01-01T00:00:01Z",
      reverted_at: null,
    }]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<InvestmentImportWizard accounts={accounts} />);

    const undo = await screen.findByRole("button", { name: /undo batch/i });
    fireEvent.click(undo);
    await waitFor(() => expect(mocks.revertInvestmentImport).toHaveBeenCalledWith("run-1"));
  });

  it("shows documented Superhero export guidance and preset scope", async () => {
    render(<InvestmentImportWizard accounts={accounts} />);
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "Superhero" } });

    expect(await screen.findByText("Superhero report guidance")).toBeTruthy();
    expect(screen.getByText(/Transaction Statement for buys and sells/)).toBeTruthy();
    expect(screen.getByText(/Full Portfolio Report does not include AMIT\/AMMA/)).toBeTruthy();
    expect(screen.getByText(/does not offer DRP/)).toBeTruthy();
    expect(screen.getByText(/combines Brokerage with GST/)).toBeTruthy();
  });

  it("finds and maps a Superhero transaction header below its report preamble", async () => {
    render(<InvestmentImportWizard accounts={accounts} />);
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "Superhero" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose Superhero CSV" }));

    const previewButton = screen.getByRole("button", { name: /preview import/i });
    await waitFor(() => expect(previewButton).toHaveProperty("disabled", false));
    fireEvent.click(previewButton);

    await waitFor(() => expect(mocks.previewInvestmentImport).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "Superhero",
        date_format: "DD-MM-YYYY",
        amount_format: "DOT_DECIMAL",
        mapping: expect.objectContaining({
          occurred_at: "Transaction Date",
          activity_type: "Transaction Type",
          asset_symbol: "Security Code",
          fee_amount: "Brokerage",
        }),
      }),
    ));
  });

  it("shows the Crypto.com App preset scope and configures crypto import defaults", async () => {
    render(<InvestmentImportWizard accounts={accounts} />);
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "Crypto.com App" } });

    expect(await screen.findByText("Crypto.com App preset")).toBeTruthy();
    expect(screen.getByText(/original Token Wallet CSV/)).toBeTruthy();
    expect(screen.getByText(/card cashback or reimbursements/)).toBeTruthy();
    expect(screen.getByText(/Exchange and Onchain exports use different formats/)).toBeTruthy();
  });

  it("surfaces annual-statement conflicts for explicit resolution", async () => {
    mocks.listInvestmentReconciliationItems.mockResolvedValueOnce([{
      id: "review-1",
      account_id: "account-1",
      source_activity_id: "activity-1",
      income_event_id: "income-1",
      kind: "component_conflict",
      status: "pending",
      reason: "Annual statement values conflict with recorded data.",
      candidate_income_event_ids: ["income-1"],
      candidate_transaction_ids: [],
      details: { conflicts: { franking_credit: { existing: "10", statement: "12" } } },
      resolution: null,
      resolved_at: null,
      created_at: "2025-07-01T00:00:00Z",
    }]);
    render(<InvestmentImportWizard accounts={accounts} />);

    expect(await screen.findByText(/Annual statement values conflict/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /use statement values/i }));

    await waitFor(() => expect(mocks.resolveInvestmentReconciliationItem).toHaveBeenCalledWith(
      "review-1",
      { action: "apply_statement" },
    ));
  });

  it("requires external review for a possible AMIT CGT event E10", async () => {
    mocks.listInvestmentReconciliationItems.mockResolvedValueOnce([{
      id: "review-e10",
      account_id: "account-1",
      source_activity_id: "activity-e10",
      income_event_id: "income-1",
      kind: "component_conflict",
      status: "pending",
      reason: "Cost-base adjustment needs review.",
      candidate_income_event_ids: ["income-1"],
      candidate_transaction_ids: [],
      details: { conflicts: { cost_base_adjustment: { reason: "would reduce cost base below zero" } } },
      resolution: null,
      resolved_at: null,
      created_at: "2025-07-01T00:00:00Z",
    }]);
    render(<InvestmentImportWizard accounts={accounts} />);

    expect(await screen.findByText(/may create CGT event E10/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /use statement values/i })).toBeNull();
    expect(screen.getByRole("button", { name: /keep recorded values/i })).toBeTruthy();
  });

  it("shows unresolved crypto transfers without classifying them as disposals", async () => {
    mocks.listInvestmentCryptoTransfers.mockResolvedValueOnce([{
      id: "transfer-1",
      account_id: "account-1",
      source_activity_id: "activity-1",
      matched_transfer_id: null,
      direction: "out",
      asset_symbol: "BTC",
      quantity: "0.25",
      occurred_at: "2025-08-01T12:00:00Z",
      transaction_hash: "abc123",
      status: "pending",
      match_method: null,
      reason: "Awaiting a unique opposite movement in another owned account.",
      assumptions: [],
    }]);

    render(<InvestmentImportWizard accounts={accounts} />);

    expect(await screen.findByText("Sent 0.25 BTC")).toBeTruthy();
    expect(screen.getByText("pending")).toBeTruthy();
    expect(screen.getByText(/excluded from CGT only after a unique matching movement/i)).toBeTruthy();
    expect(screen.getByText("Review required")).toBeTruthy();
  });

  it("lets the user confirm an ambiguous owned-wallet transfer", async () => {
    mocks.listInvestmentCryptoTransfers.mockResolvedValueOnce([{
      id: "transfer-out",
      account_id: "account-1",
      source_activity_id: "activity-out",
      matched_transfer_id: null,
      direction: "out",
      asset_symbol: "ETH",
      quantity: "1.5",
      occurred_at: "2025-08-01T12:00:00Z",
      transaction_hash: null,
      status: "ambiguous",
      match_method: null,
      confidence: "medium",
      candidate_transfers: [{
        id: "transfer-in",
        account_id: "account-2",
        account_name: "Cold wallet",
        direction: "in",
        occurred_at: "2025-08-01T12:05:00Z",
        match_method: "quantity_time_window",
        confidence: "medium",
      }],
      reason: "Multiple opposite movements match by quantity and time.",
      assumptions: [],
    }]);

    render(<InvestmentImportWizard accounts={accounts} />);
    fireEvent.click(await screen.findByRole("button", {
      name: "Confirm Cold wallet · medium",
    }));

    await waitFor(() => expect(mocks.confirmInvestmentCryptoTransfer).toHaveBeenCalledWith(
      "transfer-out",
      "transfer-in",
    ));
  });
});
