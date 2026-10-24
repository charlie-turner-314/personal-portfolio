import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ColumnDef } from "@tanstack/react-table";
const viewport = vi.hoisted(() => ({ mobile: true }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => viewport.mobile }));
import { DataTable } from "./data-table";

type Entry = { description: string; amount: number };
const columns: ColumnDef<Entry>[] = [
  { accessorKey: "description", header: "Description" },
  { accessorKey: "amount", header: "Amount" },
];
const entries = [{ description: "Groceries", amount: 42 }];

describe("DataTable mobile presentation", () => {
  beforeEach(() => window.sessionStorage.clear());
  it("offers cards, sorting and the complete table while retaining table state", () => {
    viewport.mobile = true;
    const sort = vi.fn();
    render(<DataTable columns={columns} data={entries} onSortingStateChange={sort} mobileColumnLabels={{ amount: "Amount", description: "Description" }} mobileRow={(row) => <article><button onClick={() => row.toggleSelected()}>{row.getIsSelected() ? "Selected entry" : "Select entry"}</button>{row.original.description}: {row.original.amount}</article>} />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("article")).toHaveTextContent("Groceries: 42");
    fireEvent.change(screen.getByRole("combobox", { name: "Sort transactions by" }), { target: { value: "amount" } });
    expect(sort).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Select entry" }));
    fireEvent.click(screen.getByRole("button", { name: "Table", exact: true }));
    expect(screen.getByRole("table")).toHaveTextContent("Groceries");
    fireEvent.click(screen.getByRole("button", { name: "Cards", exact: true }));
    expect(screen.getByRole("button", { name: "Selected entry" })).toBeVisible();
  });

  it("restores the chosen table view after a route remount", () => {
    viewport.mobile = true;
    const props = { columns, data: entries, mobileRow: () => <article>Mobile card</article> };
    const view = render(<DataTable {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Table", exact: true }));
    view.unmount();
    render(<DataTable {...props} />);
    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it("keeps a selection attached to the same transaction when server order changes", () => {
    viewport.mobile = true;
    const data = [...entries, { description: "Rent", amount: 900 }];
    const props = { columns, getRowId: (row: Entry) => row.description, mobileRow: (row: import("@tanstack/react-table").Row<Entry>) => <button onClick={() => row.toggleSelected()}>{row.getIsSelected() ? "Selected" : "Select"} {row.original.description}</button> };
    const view = render(<DataTable {...props} data={data} />);
    fireEvent.click(screen.getByRole("button", { name: "Select Groceries" }));
    view.rerender(<DataTable {...props} data={[...data].reverse()} />);
    expect(screen.getByRole("button", { name: "Selected Groceries" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Select Rent" })).toBeVisible();
  });

  it("keeps the desktop table presentation", () => {
    viewport.mobile = false;
    render(<DataTable columns={columns} data={entries} mobileRow={() => <article>Mobile card</article>} />);
    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cards", exact: true })).not.toBeInTheDocument();
  });
});
