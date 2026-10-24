"use client";

import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
  type VisibilityState,
  type ColumnSizingState,
  type OnChangeFn,
  type RowSelectionState,
  type Row,
  type PaginationState,
  type Table as TanStackTable,
} from "@tanstack/react-table";

import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  getRowId?: (row: TData, index: number) => string;
  onRowClick?: (row: TData) => void;
  enableColumnResizing?: boolean;
  enableRowSelection?: boolean;
  enablePagination?: boolean;
  manualPagination?: boolean;
  manualSorting?: boolean;
  pageCount?: number;
  rowCount?: number;
  paginationState?: PaginationState;
  onPaginationStateChange?: OnChangeFn<PaginationState>;
  sortingState?: SortingState;
  onSortingStateChange?: OnChangeFn<SortingState>;
  pageSize?: number;
  initialColumnFilters?: ColumnFiltersState;
  onColumnFiltersChange?: (filters: ColumnFiltersState) => void;
  toolbar?: (table: TanStackTable<TData>) => React.ReactNode;
  pagination?: (table: TanStackTable<TData>) => React.ReactNode;
  bulkActions?: (table: TanStackTable<TData>) => React.ReactNode;
  footer?: React.ReactNode;
  mobileRow?: (row: Row<TData>) => React.ReactNode;
  mobileColumnLabels?: Record<string, string>;
  mobileSortColumns?: string[];
  wrapperClassName?: string;
  tableContainerClassName?: string;
  tableContainerProps?: React.HTMLAttributes<HTMLDivElement>;
}

export function DataTable<TData, TValue>({
  columns,
  data,
  getRowId,
  onRowClick,
  enableColumnResizing = true,
  enableRowSelection = true,
  enablePagination = true,
  manualPagination = false,
  manualSorting = false,
  pageCount,
  rowCount,
  paginationState,
  onPaginationStateChange,
  sortingState,
  onSortingStateChange,
  pageSize = 20,
  initialColumnFilters = [],
  onColumnFiltersChange,
  toolbar,
  pagination,
  bulkActions,
  footer,
  mobileRow,
  mobileColumnLabels = {},
  mobileSortColumns,
  wrapperClassName,
  tableContainerClassName,
  tableContainerProps,
}: DataTableProps<TData, TValue>) {
  const isMobile = useIsMobile();
  const [mobileView, setMobileView] = React.useState<"cards" | "table">("cards");
  const showMobileCards = isMobile && mobileRow && mobileView === "cards";
  const [uncontrolledSorting, setUncontrolledSorting] = React.useState<SortingState>([]);
  const resolvedSorting = sortingState ?? uncontrolledSorting;
  const setResolvedSorting: OnChangeFn<SortingState> = (updater) => {
    if (onSortingStateChange) {
      onSortingStateChange(updater);
      return;
    }
    setUncontrolledSorting(updater);
  };
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    initialColumnFilters
  );

  // Notify parent when filters change
  React.useEffect(() => {
    onColumnFiltersChange?.(columnFilters);
  }, [columnFilters, onColumnFiltersChange]);
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const [columnSizing, setColumnSizing] = React.useState<ColumnSizingState>({});
  const [uncontrolledPagination, setUncontrolledPagination] = React.useState<PaginationState>({
    pageIndex: 0,
    pageSize,
  });
  const resolvedPagination = paginationState ?? uncontrolledPagination;
  const setResolvedPagination: OnChangeFn<PaginationState> = (updater) => {
    if (onPaginationStateChange) {
      onPaginationStateChange(updater);
      return;
    }
    setUncontrolledPagination(updater);
  };

  const table = useReactTable({
    data,
    columns,
    getRowId,
    onSortingChange: setResolvedSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel:
      enablePagination && !manualPagination ? getPaginationRowModel() : undefined,
    getSortedRowModel: manualSorting ? undefined : getSortedRowModel(),
    manualPagination,
    manualSorting,
    pageCount,
    rowCount,
    onPaginationChange: enablePagination ? setResolvedPagination : undefined,
    getFilteredRowModel: getFilteredRowModel(),
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: enableRowSelection ? setRowSelection : undefined,
    onColumnSizingChange: setColumnSizing,
    enableColumnResizing,
    columnResizeMode: "onChange",
    state: {
      sorting: resolvedSorting,
      columnFilters,
      columnVisibility,
      rowSelection,
      columnSizing,
      pagination: resolvedPagination,
    },
    initialState: {
      pagination: {
        pageSize,
      },
    },
  });

  return (
    <div className={cn("w-full", wrapperClassName)}>
      {toolbar && <div className="shrink-0 mb-4">{toolbar(table)}</div>}
      {isMobile && mobileRow && (
        <div className="mb-3 flex flex-wrap items-center gap-2" aria-label="Transaction view">
          <Button variant={mobileView === "cards" ? "default" : "outline"} className="min-h-11" aria-pressed={mobileView === "cards"} onClick={() => setMobileView("cards")}>Cards</Button>
          <Button variant={mobileView === "table" ? "default" : "outline"} className="min-h-11" aria-pressed={mobileView === "table"} onClick={() => setMobileView("table")}>Table</Button>
        </div>
      )}
      {showMobileCards ? (
        <div className="space-y-3" {...tableContainerProps}>
          <div className="flex flex-wrap items-center gap-2 border p-3">
            {table.getHeaderGroups()[0]?.headers.filter((header) => header.column.id === "select").map((header) => (
              <label key={header.id} className="flex min-h-11 items-center gap-2 text-xs">
                {flexRender(header.column.columnDef.header, header.getContext())} Select all
              </label>
            ))}
            <label className="flex min-w-32 flex-1 flex-col gap-1 text-xs">
              Sort by
              <select aria-label="Sort transactions by" className="h-11 min-w-0 border bg-background px-2 text-base" value={resolvedSorting[0]?.id ?? ""} onChange={(event) => table.setSorting([{ id: event.target.value, desc: resolvedSorting[0]?.desc ?? true }])}>
                {!resolvedSorting.length && <option value="">Default order</option>}
                {table.getAllLeafColumns().filter((column) => column.getCanSort() && (!mobileSortColumns || mobileSortColumns.includes(column.id))).map((column) => <option key={column.id} value={column.id}>{mobileColumnLabels[column.id] ?? column.id}</option>)}
              </select>
            </label>
            <Button className="min-h-11 self-end" variant="outline" aria-label="Reverse sort order" onClick={() => table.setSorting([{ id: resolvedSorting[0]?.id ?? table.getAllLeafColumns().find((column) => column.getCanSort())!.id, desc: !(resolvedSorting[0]?.desc ?? true) }])}>{resolvedSorting[0]?.desc === false ? "Ascending" : "Descending"}</Button>
          </div>
          {table.getRowModel().rows.length ? table.getRowModel().rows.map((row) => <React.Fragment key={row.id}>{mobileRow(row)}</React.Fragment>) : <p className="border p-6 text-center text-sm">No results.</p>}
        </div>
      ) : <div
        className={cn(
          "overflow-auto rounded-md border relative",
          tableContainerClassName,
          tableContainerProps?.className
        )}
        {...(tableContainerProps
          ? (() => {
              const { className, ...rest } = tableContainerProps;
              return rest;
            })()
          : {})}
      >
        <table className="w-full table-fixed caption-bottom text-xs">
          <TableHeader className="bg-muted sticky top-0 z-20 shadow-sm">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="border-b hover:bg-transparent">
                {headerGroup.headers.map((header, index) => {
                  const isLastColumn = index === headerGroup.headers.length - 1;
                  return (
                    <TableHead
                      key={header.id}
                      style={{
                        width: isLastColumn ? "auto" : header.getSize(),
                        maxWidth: isLastColumn ? undefined : header.getSize(),
                        position: "relative",
                      }}
                      className={cn(
                        "font-medium bg-muted overflow-hidden",
                        enableColumnResizing && "select-none"
                      )}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                      {enableColumnResizing && header.column.getCanResize() && (
                        <div
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          className={cn(
                            "absolute -right-1 top-0 h-full w-3 cursor-col-resize select-none touch-none",
                            "after:absolute after:right-1 after:top-0 after:h-full after:w-px after:bg-transparent",
                            "hover:after:bg-primary/50",
                            header.column.getIsResizing() && "after:bg-primary"
                          )}
                        />
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                  onClick={() => onRowClick?.(row.original)}
                  className={cn(onRowClick && "cursor-pointer")}
                >
                  {row.getVisibleCells().map((cell, index) => {
                    const isLastColumn = index === row.getVisibleCells().length - 1;
                    return (
                      <TableCell
                        key={cell.id}
                        className="overflow-hidden"
                        style={{
                          width: isLastColumn ? "auto" : cell.column.getSize(),
                          maxWidth: isLastColumn ? undefined : cell.column.getSize(),
                        }}
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext()
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center"
                >
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </table>
      </div>}
      {footer && <div className="shrink-0">{footer}</div>}
      {pagination && <div className="shrink-0 mt-4">{pagination(table)}</div>}
      {bulkActions && bulkActions(table)}
    </div>
  );
}

export { type TanStackTable };
