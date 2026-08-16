"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { importHistoricalSnapshots } from "@/lib/actions/historical-snapshots";
import { parseDelimitedText, detectCsvDelimiter } from "@/lib/import/parsing";
import { parseHistoricalSnapshotCsv, suggestHistoricalSnapshotColumns, type HistoricalSnapshotMapping } from "@/lib/import/historical-snapshots";
import { HISTORICAL_METRICS } from "@/lib/import/historical-snapshot-metrics";

export function HistoricalSnapshotImporter({ disabled = false }: { disabled?: boolean }) {
  const [fileName, setFileName] = useState(""); const [content, setContent] = useState("");
  const [mapping, setMapping] = useState<HistoricalSnapshotMapping>({ month: "" });
  const [mode, setMode] = useState<"skip" | "replace">("skip"); const [attested, setAttested] = useState(false); const [saving, setSaving] = useState(false);
  const parsed = useMemo(() => content ? parseDelimitedText(content, detectCsvDelimiter(content)) : { headers: [], rows: [] }, [content]);
  const preview = useMemo(() => mapping.month ? parseHistoricalSnapshotCsv(content, mapping) : [], [content, mapping]);
  async function onFile(file?: File) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) { toast.error("Historical snapshots support CSV files only."); return; }
    const nextContent = await file.text(); const nextParsed = parseDelimitedText(nextContent, detectCsvDelimiter(nextContent)); const suggested = suggestHistoricalSnapshotColumns(nextParsed.headers);
    setFileName(file.name); setContent(nextContent); setMapping(suggested);
  }
  async function submit() {
    setSaving(true); const result = await importHistoricalSnapshots(fileName, preview.map(({ date, netWorth, metrics }) => ({ date, netWorth, metrics })), mode); setSaving(false);
    if (!result.success) { toast.error(result.error); return; }
    toast.success(`Imported ${result.imported} historical snapshot${result.imported === 1 ? "" : "s"}${result.skipped ? `; skipped ${result.skipped} duplicate${result.skipped === 1 ? "" : "s"}` : ""}.`);
    setContent(""); setFileName(""); setMapping({ month: "" });
  }
  return <Card>
    <CardHeader><CardTitle className="text-sm">Historical net worth</CardTitle><CardDescription>Upload a CSV of dated net-worth snapshots. This does not create transactions or cashflow. CSV only.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      {!content ? <Input aria-label="Historical snapshots CSV" type="file" accept=".csv,text/csv" disabled={disabled} onChange={(event) => onFile(event.target.files?.[0])} /> : <>
        <p className="text-sm text-muted-foreground">1. Mapping columns from <span className="font-medium text-foreground">{fileName}</span></p>
        <div className="grid gap-3 sm:grid-cols-2"><ColumnSelect label="Month column" value={mapping.month} onChange={(month) => setMapping((current) => ({ ...current, month }))} headers={parsed.headers} />{HISTORICAL_METRICS.map((metric) => <ColumnSelect key={metric.key} label={metric.label} value={mapping[metric.key] || ""} onChange={(value) => setMapping((current) => ({ ...current, [metric.key]: value }))} headers={parsed.headers} optional />)}</div>
        <div><p className="mb-2 text-sm font-medium">2. Preview ({preview.filter((row) => row.date && row.netWorth !== null).length} valid rows; monthly dates are stored at month end)</p><div className="max-h-36 overflow-auto rounded border p-2 text-xs">{preview.slice(0, 5).map((row, index) => <div key={index}>{row.date || "Invalid month"} — net worth {row.netWorth ?? "not imported"}{row.warnings.length ? ` (${row.warnings.join(", ")})` : ""}</div>)}</div></div>
        <label className="flex items-start gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={attested} onChange={(event) => setAttested(event.target.checked)} />I have the right to import this local CSV and will comply with its source terms.</label>
        <div className="flex flex-wrap items-center gap-3"><Select value={mode} onValueChange={(value) => setMode(value as "skip" | "replace")}><SelectTrigger className="w-48"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="skip">Skip duplicate months</SelectItem><SelectItem value="replace">Replace duplicate months</SelectItem></SelectContent></Select><Button disabled={disabled || saving || !attested || !preview.some((row) => row.date && row.netWorth !== null)} onClick={submit}>{saving ? "Importing…" : "3. Confirm import"}</Button><Button variant="ghost" onClick={() => { setContent(""); setFileName(""); setAttested(false); }}>Choose another file</Button></div>
      </>}
    </CardContent>
  </Card>;
}
function ColumnSelect({ label, value, onChange, headers, optional = false }: { label: string; value: string; onChange: (value: string) => void; headers: string[]; optional?: boolean }) { return <div><label className="mb-1 block text-sm font-medium">{label}{optional ? " (optional)" : ""}</label><Select value={value} onValueChange={(next) => onChange(next || "")}><SelectTrigger><SelectValue placeholder="Select column" /></SelectTrigger><SelectContent>{optional && <SelectItem value="__none">Not in this file</SelectItem>}{headers.map((header) => <SelectItem key={header} value={header}>{header}</SelectItem>)}</SelectContent></Select></div>; }
