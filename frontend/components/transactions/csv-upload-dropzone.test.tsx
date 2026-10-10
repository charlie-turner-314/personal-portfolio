import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CsvUploadDropzone } from "./csv-upload-dropzone";


describe("CsvUploadDropzone", () => {
  it("encodes an allowed PDF as base64 for the investment importer", async () => {
    const onFileSelect = vi.fn();
    const { container } = render(
      <CsvUploadDropzone onFileSelect={onFileSelect} acceptPdf />,
    );
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    const file = new File(["%PDF-1.7"], "statement.pdf", { type: "application/pdf" });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(onFileSelect).toHaveBeenCalledWith(
      file,
      "JVBERi0xLjc=",
      "base64",
    ));
  });

  it("rejects PDF input when the caller has not enabled it", () => {
    const onFileSelect = vi.fn();
    const { container } = render(<CsvUploadDropzone onFileSelect={onFileSelect} />);
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    const file = new File(["%PDF-1.7"], "statement.pdf", { type: "application/pdf" });

    fireEvent.change(input, { target: { files: [file] } });

    expect(screen.getByText("Please upload a CSV or Excel file")).toBeTruthy();
    expect(onFileSelect).not.toHaveBeenCalled();
  });
});
