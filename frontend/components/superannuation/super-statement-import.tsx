"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { RiArrowLeftLine, RiCheckLine, RiFileUploadLine } from "@remixicon/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CsvUploadDropzone } from "@/components/transactions/csv-upload-dropzone";
import {
  importSuperStatement,
  initializeCsvImport,
  parseCsvHeaders,
  type ParsedCsvData,
  type SuperStatementColumnMapping,
} from "@/lib/actions/csv-import";

interface SuperStatementImportProps {
  accountId: string;
}

const EMPTY_MAPPING: SuperStatementColumnMapping = {
  date: null,
  amount: null,
  eventType: null,
  balance: null,
  description: null,
  typeConfig: { amountFormat: "AUTO", dateFormat: "DD-MM-YYYY" },
};

const MAPPING_FIELDS: Array<{
  key: keyof Omit<SuperStatementColumnMapping, "typeConfig">;
  label: string;
  description: string;
  required: boolean;
}> = [
  { key: "date", label: "Date", description: "Statement event or valuation date", required: true },
  { key: "amount", label: "Amount", description: "Contribution, fee, or insurance amount", required: false },
  { key: "eventType", label: "Event type", description: "Contribution, fee, or insurance classification", required: false },
  { key: "balance", label: "Balance", description: "Optional statement balance snapshot", required: false },
  { key: "description", label: "Description", description: "Optional statement narration", required: false },
];

export function SuperStatementImport({ accountId }: SuperStatementImportProps) {
  const router = useRouter();
  const [importId, setImportId] = useState<string | null>(null);
  const [csvData, setCsvData] = useState<ParsedCsvData | null>(null);
  const [mapping, setMapping] = useState<SuperStatementColumnMapping>(EMPTY_MAPPING);
  const [isUploading, setIsUploading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  const canImport = Boolean(
    importId &&
      mapping.date &&
      (mapping.balance || (mapping.amount && mapping.eventType)),
  );
  const mappedHeaders = useMemo(
    () => MAPPING_FIELDS.filter((field) => mapping[field.key]),
    [mapping],
  );

  const handleFileSelect = async (file: File, content: string) => {
    setIsUploading(true);
    setResultMessage(null);
    try {
      const initialized = await initializeCsvImport(accountId, file.name, content);
      if (!initialized.success || !initialized.importId) {
        toast.error(initialized.error || "Unable to start super statement import");
        return;
      }
      const parsed = await parseCsvHeaders(initialized.importId);
      if (!parsed.success || !parsed.data) {
        toast.error(parsed.error || "Unable to read statement columns");
        return;
      }
      setImportId(initialized.importId);
      setCsvData(parsed.data);
      setMapping(EMPTY_MAPPING);
    } catch {
      toast.error("Unable to prepare super statement import");
    } finally {
      setIsUploading(false);
    }
  };

  const updateMapping = (
    field: keyof Omit<SuperStatementColumnMapping, "typeConfig">,
    value: string,
  ) => {
    setMapping((current) => ({ ...current, [field]: value === "none" ? null : value }));
  };

  const handleImport = async () => {
    if (!importId || !canImport) return;
    setIsImporting(true);
    setResultMessage(null);
    try {
      const result = await importSuperStatement(importId, mapping);
      if (!result.success) {
        toast.error(result.error || "Unable to import super statement");
        return;
      }
      const message = [
        `${result.contributionsImported ?? 0} contributions`,
        `${result.balanceSnapshotsImported ?? 0} balance snapshots`,
        result.duplicatesSkipped ? `${result.duplicatesSkipped} duplicates skipped` : null,
        result.rowsNeedingAttention ? `${result.rowsNeedingAttention} rows need attention` : null,
      ].filter(Boolean).join(", ");
      setResultMessage(message);
      toast.success("Super statement imported");
    } catch {
      toast.error("Unable to import super statement");
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Import super statement</h1>
          <p className="text-sm text-muted-foreground">
            Import contribution events and dated balance snapshots without creating bank transactions.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => router.push(`/accounts/${accountId}`)}>
          <RiArrowLeftLine className="mr-2 h-4 w-4" />Back to account
        </Button>
      </div>

      {!csvData ? (
        <CsvUploadDropzone onFileSelect={handleFileSelect} isUploading={isUploading} />
      ) : (
        <>
          <section className="border bg-card p-4">
            <div className="mb-4 flex items-center gap-2">
              <RiFileUploadLine className="h-4 w-4 text-muted-foreground" />
              <div>
                <h2 className="text-sm font-medium">Map statement columns</h2>
                <p className="text-xs text-muted-foreground">
                  Map Date plus either Balance, or Amount and Event type. Description is optional.
                </p>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {MAPPING_FIELDS.map((field) => (
                <div className="flex items-center justify-between gap-4 border p-3" key={field.key}>
                  <div>
                    <Label>
                      {field.label}{field.required ? <span className="text-destructive"> *</span> : null}
                    </Label>
                    <p className="mt-1 text-xs text-muted-foreground">{field.description}</p>
                  </div>
                  <Select
                    value={mapping[field.key] || "none"}
                    onValueChange={(value) => {
                      if (value) updateMapping(field.key, value);
                    }}
                  >
                    <SelectTrigger className="w-44"><SelectValue placeholder="Select column" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Not mapped</SelectItem>
                      {csvData.headers.map((header) => <SelectItem key={header} value={header}>{header}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </section>

          <section className="border bg-card p-4">
            <h2 className="mb-3 text-sm font-medium">Statement sample</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-muted/50">
                  <tr>
                    {mappedHeaders.map((field) => <th className="px-3 py-2 font-medium" key={field.key}>{field.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {csvData.sampleRows.map((row, index) => (
                    <tr className="border-t" key={index}>
                      {mappedHeaders.map((field) => {
                        const column = mapping[field.key];
                        const value = column ? row[csvData.headers.indexOf(column)] : "";
                        return <td className="px-3 py-2" key={field.key}>{value || "-"}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {resultMessage ? (
            <div className="flex items-center gap-2 border border-green-500/50 bg-green-500/10 p-3 text-sm" role="status">
              <RiCheckLine className="h-4 w-4 text-green-600" />{resultMessage}
            </div>
          ) : null}
          <div className="flex justify-end">
            <Button type="button" onClick={handleImport} disabled={!canImport || isImporting}>
              {isImporting ? "Importing statement..." : "Import super statement"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
