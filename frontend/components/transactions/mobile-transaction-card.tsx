"use client";

import { flexRender, type Row } from "@tanstack/react-table";
import type { TransactionWithRelations } from "@/lib/actions/transactions";

export const transactionFieldLabels: Record<string, string> = {
  bookedAt: "Date", description: "Description", merchant: "Merchant", category: "Category",
  amount: "Amount", account: "Account", recurringTransaction: "Subscription",
  subscription: "Subscription", transactionType: "Type", transactionLink: "Linked transactions", linkedTransaction: "Linked transactions", link: "Linked transactions",
  pending: "Status", includeInAnalytics: "Analytics", status: "Status", analytics: "Analytics",
};

export function MobileTransactionCard({ row, onOpen }: { row: Row<TransactionWithRelations>; onOpen: (transaction: TransactionWithRelations) => void }) {
  const cells = row.getVisibleCells();
  const renderCell = (id: string) => {
    const cell = cells.find((cell) => cell.column.id === id);
    return cell ? flexRender(cell.column.columnDef.cell, cell.getContext()) : null;
  };
  return (
    <article aria-label={row.original.description || "Transaction"} data-state={row.getIsSelected() ? "selected" : undefined} className="space-y-3 border p-3 data-[state=selected]:bg-muted/50 [&_.truncate]:whitespace-normal [&_.truncate]:overflow-visible [&_.truncate]:break-words [&_.truncate]:text-clip">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-h-11 items-center gap-2 text-xs">{renderCell("select")}{renderCell("bookedAt")}</div>
        <div className="text-base font-semibold">{renderCell("amount")}</div>
      </div>
      <button type="button" className="block min-h-11 w-full break-words text-left text-sm font-medium underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2" onClick={() => onOpen(row.original)} aria-label={`View transaction: ${row.original.description || "Transaction"}`}>{row.original.description || "Transaction"}</button>
      <dl className="grid grid-cols-1 gap-3 text-xs">
        {cells.filter((cell) => !["select", "bookedAt", "amount", "description"].includes(cell.column.id)).map((cell) => (
          <div key={cell.id} className="flex min-w-0 flex-wrap items-start justify-between gap-2">
            <dt className="text-muted-foreground">{transactionFieldLabels[cell.column.id] ?? cell.column.id}</dt>
            <dd className="min-w-0 max-w-full break-words">{flexRender(cell.column.columnDef.cell, cell.getContext())}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}
