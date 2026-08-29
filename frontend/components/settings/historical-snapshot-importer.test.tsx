import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  importHistoricalSnapshots: vi.fn().mockResolvedValue({ success: true, imported: 1, skipped: 0 }),
}));
vi.mock("@/lib/actions/historical-snapshots", () => ({ importHistoricalSnapshots: mocks.importHistoricalSnapshots }));

import { HistoricalSnapshotImporter } from "./historical-snapshot-importer";

describe("HistoricalSnapshotImporter smoke flow", () => {
  it("accepts a local CSV, previews its mapped snapshot, and confirms only after attestation", async () => {
    render(<HistoricalSnapshotImporter />);

    const file = new File(["Month,Cash\n2024-01,1234.50\n"], "history.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("Historical snapshots CSV"), { target: { files: [file] } });

    expect(await screen.findByText(/2\. Preview \(1 valid rows/)).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "3. Confirm import" });
    expect(confirm).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(confirm).toHaveProperty("disabled", false);
    fireEvent.click(confirm);

    await waitFor(() => expect(mocks.importHistoricalSnapshots).toHaveBeenCalledWith(
      "history.csv",
      [expect.objectContaining({ date: "2024-01-31", netWorth: 1234.5, metrics: { cash: 1234.5 } })],
      "skip",
    ));
  });
});
