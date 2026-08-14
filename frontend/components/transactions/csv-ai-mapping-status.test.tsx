import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CsvAiMappingStatus } from "./csv-ai-mapping-status";

function renderStatus(status: "idle" | "analyzing" | "succeeded" | "failed" | "timed_out") {
  const onRetry = vi.fn();
  const onMapManually = vi.fn();

  render(
    <CsvAiMappingStatus
      status={status}
      onRetry={onRetry}
      onMapManually={onMapManually}
    />
  );

  return { onRetry, onMapManually };
}

describe("CsvAiMappingStatus", () => {
  it("keeps a visible active status while AI analysis is slow", () => {
    renderStatus("analyzing");

    expect(screen.getByRole("status")).toHaveTextContent(
      "Analyzing headers and sample transactions. This can take up to 30 seconds."
    );
  });

  it("confirms that a successful AI mapping was applied", () => {
    renderStatus("succeeded");

    expect(screen.getByRole("status")).toHaveTextContent(
      "AI mapping applied. Review the suggested fields before previewing transactions."
    );
  });

  it("offers retry and manual mapping after an AI failure", () => {
    const { onRetry, onMapManually } = renderStatus("failed");

    expect(screen.getByRole("alert")).toHaveTextContent("AI could not analyze this CSV");
    fireEvent.click(screen.getByRole("button", { name: "Retry AI analysis" }));
    fireEvent.click(screen.getByRole("button", { name: "Map columns manually" }));

    expect(onRetry).toHaveBeenCalledOnce();
    expect(onMapManually).toHaveBeenCalledOnce();
  });

  it("shows timeout guidance with the same recovery actions", () => {
    const { onRetry, onMapManually } = renderStatus("timed_out");

    expect(screen.getByRole("alert")).toHaveTextContent("AI analysis timed out");
    fireEvent.click(screen.getByRole("button", { name: "Retry AI analysis" }));
    fireEvent.click(screen.getByRole("button", { name: "Map columns manually" }));

    expect(onRetry).toHaveBeenCalledOnce();
    expect(onMapManually).toHaveBeenCalledOnce();
  });
});
