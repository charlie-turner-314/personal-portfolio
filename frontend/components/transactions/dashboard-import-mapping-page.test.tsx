import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiColumnMappingResult, ColumnMapping } from "@/lib/actions/csv-import";
import MappingPage from "@/app/(dashboard)/transactions/import/mapping/page";
import {
  getAiColumnMapping,
  getCsvImportSession,
  parseCsvHeaders,
  saveColumnMapping,
} from "@/lib/actions/csv-import";

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => ({ get: () => "import-1" }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/components/layout/header", () => ({
  Header: ({ title }: { title: string }) => <header>{title}</header>,
}));

vi.mock("@/components/transactions/csv-mapping-table", () => ({
  CsvMappingTable: () => <div data-testid="mapping-table" />,
}));

vi.mock("@/components/transactions/csv-sample-preview", () => ({
  CsvSamplePreview: () => <div data-testid="sample-preview" />,
}));

vi.mock("@/lib/actions/csv-import", () => ({
  getAiColumnMapping: vi.fn(),
  getCsvImportSession: vi.fn(),
  parseCsvHeaders: vi.fn(),
  saveColumnMapping: vi.fn(),
}));

const MAPPING: ColumnMapping = {
  date: "Date",
  amount: "Amount",
  debitAmount: null,
  creditAmount: null,
  description: "Description",
  merchant: null,
  transactionType: null,
  fee: null,
  state: null,
  startingBalance: null,
  endingBalance: null,
  typeConfig: {},
};

const SUCCESS: AiColumnMappingResult = {
  outcome: "success",
  success: true,
  mapping: MAPPING,
};

const SESSION = {
  id: "import-1",
  accountId: "account-1",
  fileName: "transactions.csv",
  status: "mapping",
  columnMapping: null,
  importProfileId: null,
  importProfileName: null,
  profileApplied: false,
  totalRows: 2,
};

const CSV_DATA = {
  headers: ["Date", "Description", "Amount"],
  rows: [["2026-01-01", "Coffee", "-4.50"]],
  sampleRows: [["2026-01-01", "Coffee", "-4.50"]],
};

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });

  return { promise, resolve: resolve! };
}

function previewButton() {
  return screen.getByRole("button", { name: "Preview Transactions" });
}

describe("dashboard CSV import mapping page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCsvImportSession).mockResolvedValue(SESSION);
    vi.mocked(parseCsvHeaders).mockResolvedValue({ success: true, data: CSV_DATA });
    vi.mocked(saveColumnMapping).mockResolvedValue({ success: true });
  });

  it("keeps Preview disabled while a slow AI analysis is pending", async () => {
    const analysis = deferred<AiColumnMappingResult>();
    vi.mocked(getAiColumnMapping).mockReturnValue(analysis.promise);

    render(<MappingPage />);

    await screen.findByRole("status");
    expect(previewButton()).toBeDisabled();
  });

  it("applies a successful mapping, confirms it, and enables Preview", async () => {
    vi.mocked(getAiColumnMapping).mockResolvedValue(SUCCESS);

    render(<MappingPage />);

    expect(await screen.findByText(/AI mapping applied/i)).toBeInTheDocument();
    expect(previewButton()).toBeEnabled();
  });

  it("shows recovery actions after failure, keeps Preview enabled, and retries AI analysis", async () => {
    vi.mocked(getAiColumnMapping).mockResolvedValue({
      outcome: "failed",
      success: false,
      error: "AI could not analyze this CSV. Try again or map the columns manually.",
    });

    render(<MappingPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("AI could not analyze this CSV");
    expect(previewButton()).toBeEnabled();
    expect(screen.getByRole("button", { name: "Map columns manually" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Retry AI analysis" }));
    await waitFor(() => expect(getAiColumnMapping).toHaveBeenCalledTimes(2));
  });

  it("shows timeout recovery actions and keeps Preview enabled for manual mapping", async () => {
    vi.mocked(getAiColumnMapping).mockResolvedValue({
      outcome: "timed_out",
      success: false,
      error: "AI analysis timed out. Try again or map the columns manually.",
    });

    render(<MappingPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("AI analysis timed out");
    expect(screen.getByRole("button", { name: "Retry AI analysis" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Map columns manually" })).toBeEnabled();
    expect(previewButton()).toBeEnabled();
  });
});
