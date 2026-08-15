import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import BudgetError from "@/app/(dashboard)/budget/error";

describe("BudgetError", () => {
  it("shows a safe diagnostic reference, logs the digest, and retries", () => {
    const reset = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(<BudgetError error={Object.assign(new Error("database details"), { digest: "budget-123" })} reset={reset} />);

    expect(screen.getByText("Budget failed to load")).toBeVisible();
    expect(screen.getByText("Reference: budget-123")).toBeVisible();
    expect(screen.queryByText("database details")).not.toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith("[budget] Failed to load budget page", {
      digest: "budget-123",
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(reset).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});
