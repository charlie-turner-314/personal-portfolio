import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StepFourImportPage from "@/app/step-4/page";

const { push, getUserAccounts, initializeCsvImport } = vi.hoisted(() => ({
  push: vi.fn(),
  getUserAccounts: vi.fn(),
  initializeCsvImport: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/components/onboarding/onboarding-progress", () => ({ OnboardingProgress: () => <div /> }));
vi.mock("@/components/transactions/csv-upload-dropzone", () => ({
  CsvUploadDropzone: ({ onFileSelect }: { onFileSelect: (file: File, content: string) => void }) => (
    <button type="button" onClick={() => onFileSelect(new File(["Date\n"], "transactions.csv"), "Date\n")}>Choose test CSV</button>
  ),
}));
vi.mock("@/lib/actions/transactions", () => ({ getUserAccounts }));
vi.mock("@/lib/actions/csv-import", () => ({ initializeCsvImport }));

describe("StepFourImportPage", () => {
  beforeEach(() => {
    push.mockReset();
    getUserAccounts.mockResolvedValue([{ id: "account-1", name: "Everyday", currency: "AUD" }]);
    initializeCsvImport.mockResolvedValue({ success: true, importId: "import-1" });
  });

  it("lets a completed user skip CSV import and enter the dashboard", async () => {
    render(<StepFourImportPage />);

    await screen.findByText("Everyday");
    fireEvent.click(screen.getByRole("button", { name: "Do this later" }));

    expect(push).toHaveBeenCalledWith("/?tour=1");
  });

  it("keeps the CSV import path available", async () => {
    render(<StepFourImportPage />);

    await screen.findByText("Everyday");
    fireEvent.click(screen.getByRole("button", { name: "Choose test CSV" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(initializeCsvImport).toHaveBeenCalledWith("account-1", "transactions.csv", "Date\n"));
    expect(push).toHaveBeenCalledWith("/step-4/mapping?id=import-1");
  });
});
