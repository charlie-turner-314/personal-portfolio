import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TransactionFilters } from "./transaction-filters";
import { parseTransactionsSearchParams } from "@/lib/transactions/query-state";

it("preserves the focused draft when an older search response arrives", () => {
  const props = {
    filters: parseTransactionsSearchParams({}),
    categories: [], accounts: [], recurringOptions: [],
    onFiltersChange: vi.fn(), onClearFilters: vi.fn(),
  };
  const { rerender } = render(<TransactionFilters {...props} />);
  const input = screen.getByPlaceholderText("Search transactions...");
  input.focus();
  fireEvent.change(input, { target: { value: "salary" } });
  rerender(<TransactionFilters {...props} filters={parseTransactionsSearchParams({ search: "sa" })} />);
  expect(input).toHaveValue("salary");
  expect(input).toHaveFocus();
  input.blur();
  rerender(<TransactionFilters {...props} filters={parseTransactionsSearchParams({ search: "rent" })} />);
  expect(input).toHaveValue("rent");
});
