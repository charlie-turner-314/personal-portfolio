import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  previewInvestmentImport: vi.fn(),
  applyInvestmentImport: vi.fn(),
  listInvestmentImportProfiles: vi.fn(),
  listInvestmentImports: vi.fn(),
  revertInvestmentImport: vi.fn(),
}));

vi.mock("@/lib/api/investments", () => mocks);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/transactions/csv-upload-dropzone", () => ({
  CsvUploadDropzone: ({ onFileSelect }: { onFileSelect: (file: File, content: string) => void }) => (
    <button type="button" onClick={() => onFileSelect(
      new File(["Reference,Date,Type,Symbol,Quantity,Price,Currency\nT1,2025-01-01,Buy,VAS,2,100,AUD\n"], "statement.csv"),
      "Reference,Date,Type,Symbol,Quantity,Price,Currency\nT1,2025-01-01,Buy,VAS,2,100,AUD\n",
    )}>Choose investment CSV</button>
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
    mocks.listInvestmentImportProfiles.mockResolvedValue([]);
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
});
