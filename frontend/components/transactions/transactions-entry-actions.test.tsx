import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddTransactionButton } from "./add-transaction-button";
import { ImportTransactionsButton } from "./import-transactions-button";

describe("transaction entry actions", () => {
  it("opens manual transaction entry directly", () => {
    const onAddManual = vi.fn();

    render(<AddTransactionButton onAddManual={onAddManual} />);
    fireEvent.click(screen.getByRole("button", { name: "Add Transaction" }));

    expect(onAddManual).toHaveBeenCalledOnce();
    expect(screen.queryByText("Import from CSV")).not.toBeInTheDocument();
  });

  it("keeps CSV import as a distinct action with the walkthrough target", () => {
    const onImport = vi.fn();

    render(<ImportTransactionsButton onImport={onImport} />);
    const button = screen.getByRole("button", { name: "Import transactions" });
    fireEvent.click(button);

    expect(onImport).toHaveBeenCalledOnce();
    expect(button).toHaveAttribute("data-walkthrough", "walkthrough-import");
  });
});
