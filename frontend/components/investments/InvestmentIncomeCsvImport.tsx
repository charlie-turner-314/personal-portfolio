"use client";

import { useMemo, useState } from "react";
import { RiCheckLine, RiFileUploadLine } from "@remixicon/react";
import { CsvUploadDropzone } from "@/components/transactions/csv-upload-dropzone";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createInvestmentIncomeSourceImportId,
  EMPTY_INVESTMENT_INCOME_MAPPING,
  parseInvestmentIncomeCsvRows,
  type InvestmentIncomeColumnMapping,
  type ParsedInvestmentIncomeRow,
} from "@/lib/investment-income/csv-import";
import { detectCsvDelimiter, parseDelimitedText } from "@/lib/import/parsing";
import type { CreateInvestmentIncomeEvent, InvestmentIncomeEvent } from "./income-types";

type MappingKey = Exclude<keyof InvestmentIncomeColumnMapping, "typeConfig">;

const MAPPING_FIELDS: Array<{ key: MappingKey; label: string; required?: boolean }> = [
  { key: "payDate", label: "Pay date", required: true },
  { key: "cashReceived", label: "Cash received", required: true },
  { key: "eventType", label: "Event type" },
  { key: "exDate", label: "Ex date" },
  { key: "frankedAmount", label: "Franked amount" },
  { key: "unfrankedAmount", label: "Unfranked amount" },
  { key: "frankingCredit", label: "Franking credit" },
  { key: "foreignIncome", label: "Foreign income" },
  { key: "foreignTaxPaid", label: "Foreign tax paid" },
  { key: "drp", label: "DRP" },
  { key: "drpQuantity", label: "DRP quantity" },
  { key: "drpPrice", label: "DRP price" },
  { key: "amitAmmaComponents", label: "AMIT/AMMA components" },
  { key: "description", label: "Description" },
];

type ImportResult = { imported: number; skipped: number; invalid: number };

export function InvestmentIncomeCsvImport({
  defaultCurrency,
  existingEvents,
  onCreate,
}: {
  defaultCurrency: string;
  existingEvents: InvestmentIncomeEvent[];
  onCreate: (event: Omit<CreateInvestmentIncomeEvent, "account_id" | "holding_id">) => Promise<unknown>;
}) {
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [sourceImportId, setSourceImportId] = useState<string | null>(null);
  const [mapping, setMapping] = useState<InvestmentIncomeColumnMapping>(EMPTY_INVESTMENT_INCOME_MAPPING);
  const [uploading, setUploading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const parsed = useMemo(() => sourceImportId
    ? parseInvestmentIncomeCsvRows(headers, rawRows, mapping, sourceImportId)
    : { rows: [], issues: [] }, [headers, mapping, rawRows, sourceImportId]);
  const existingSourceIds = useMemo(
    () => new Set(existingEvents.map((event) => event.source_id).filter((id): id is string => Boolean(id))),
    [existingEvents],
  );
  const canImport = Boolean(mapping.payDate && mapping.cashReceived && parsed.rows.length > 0);

  const handleFile = async (file: File, content: string) => {
    setUploading(true);
    setResult(null);
    try {
      const parsedFile = parseDelimitedText(content, detectCsvDelimiter(content));
      setHeaders(parsedFile.headers);
      setRawRows(parsedFile.rows);
      setSourceImportId(createInvestmentIncomeSourceImportId(file.name, content));
      setMapping(EMPTY_INVESTMENT_INCOME_MAPPING);
    } finally {
      setUploading(false);
    }
  };

  const updateMapping = (field: MappingKey, value: string) => {
    setMapping((current) => ({ ...current, [field]: value === "none" ? null : value }));
    setResult(null);
  };

  const handleImport = async () => {
    if (!canImport) return;
    setImporting(true);
    let imported = 0;
    let skipped = 0;
    let invalid = parsed.issues.length;
    try {
      for (const row of parsed.rows) {
        if (existingSourceIds.has(row.sourceRowKey)) {
          skipped += 1;
          continue;
        }
        try {
          await onCreate(toIncomePayload(row, defaultCurrency));
          imported += 1;
        } catch {
          invalid += 1;
        }
      }
      setResult({ imported, skipped, invalid });
    } finally {
      setImporting(false);
    }
  };

  if (headers.length === 0) {
    return <div className="space-y-3 border-t pt-4">
      <div>
        <h3 className="text-sm font-medium">Import income statement</h3>
        <p className="mt-1 text-xs text-muted-foreground">Import dividend and distribution rows for this holding only. Bank transactions and trade imports are unchanged.</p>
      </div>
      <CsvUploadDropzone onFileSelect={handleFile} isUploading={uploading} />
    </div>;
  }

  return <div className="space-y-4 border-t pt-4">
    <div className="flex items-center gap-2">
      <RiFileUploadLine className="size-4 text-muted-foreground" />
      <div>
        <h3 className="text-sm font-medium">Map income statement columns</h3>
        <p className="text-xs text-muted-foreground">Pay date and cash received are required. Unmapped event types import as dividends. Map DRP quantity and price for reinvested rows.</p>
      </div>
    </div>
    <div className="grid gap-3 md:grid-cols-2">
      {MAPPING_FIELDS.map((field) => <div className="flex items-center justify-between gap-3 border p-3" key={field.key}>
        <Label className="text-sm">{field.label}{field.required ? <span className="text-destructive"> *</span> : null}</Label>
        <Select value={mapping[field.key] ?? "none"} onValueChange={(value) => value && updateMapping(field.key, value)}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Select column" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Not mapped</SelectItem>
            {headers.map((header, index) => <SelectItem key={`${header}-${index}`} value={header}>{header}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>)}
    </div>
    <section className="border p-3">
      <h3 className="text-sm font-medium">Normalized preview</h3>
      {parsed.rows.length > 0 ? <div className="mt-2 overflow-x-auto"><table className="w-full text-left text-xs"><thead className="border-b text-muted-foreground"><tr><th className="p-2">Row</th><th className="p-2">Pay date</th><th className="p-2">Type</th><th className="p-2 text-right">Cash</th><th className="p-2">DRP</th></tr></thead><tbody>{parsed.rows.slice(0, 10).map((row) => <tr className="border-b last:border-0" key={row.sourceRowKey}><td className="p-2">{row.sourceRowNumber}</td><td className="p-2">{row.payDate}</td><td className="p-2 capitalize">{row.eventType}</td><td className="p-2 text-right tabular-nums">{row.cashReceived}</td><td className="p-2">{row.drp ? `${row.drpQuantity} @ ${row.drpPrice}` : "No"}</td></tr>)}</tbody></table></div> : <p className="mt-2 text-xs text-muted-foreground">Map the required fields to preview normalized rows.</p>}
      {parsed.issues.length > 0 && <div className="mt-3 text-xs text-destructive"><p className="font-medium">{parsed.issues.length} invalid row{parsed.issues.length === 1 ? "" : "s"}</p><ul className="mt-1 list-disc pl-4">{parsed.issues.slice(0, 5).map((issue) => <li key={`${issue.sourceRowNumber}-${issue.message}`}>Row {issue.sourceRowNumber}: {issue.message}</li>)}</ul></div>}
    </section>
    {result && <div className="flex items-center gap-2 border border-green-500/50 bg-green-500/10 p-3 text-sm" role="status"><RiCheckLine className="size-4 text-green-600" />{result.imported} imported, {result.skipped} skipped, {result.invalid} invalid</div>}
    <div className="flex justify-end"><Button type="button" onClick={handleImport} disabled={!canImport || importing}>{importing ? "Importing income..." : "Import income rows"}</Button></div>
  </div>;
}

function toIncomePayload(row: ParsedInvestmentIncomeRow, currency: string): Omit<CreateInvestmentIncomeEvent, "account_id" | "holding_id"> {
  return {
    event_type: row.eventType,
    pay_date: row.payDate,
    ex_date: row.exDate,
    currency,
    cash_received: row.cashReceived,
    franked_amount: row.frankedAmount,
    unfranked_amount: row.unfrankedAmount,
    franking_credit: row.frankingCredit,
    foreign_income: row.foreignIncome,
    foreign_tax_paid: row.foreignTaxPaid,
    amit_amma_components: row.amitAmmaComponents ? { raw: row.amitAmmaComponents } : null,
    is_drp: row.drp,
    drp_quantity: row.drpQuantity,
    drp_price: row.drpPrice,
    source_id: row.sourceRowKey,
    notes: row.description,
  };
}
