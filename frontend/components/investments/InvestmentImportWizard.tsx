"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RiAlertLine, RiCheckLine, RiDeleteBinLine, RiLoader4Line } from "@remixicon/react";
import { toast } from "sonner";
import {
  applyInvestmentImport,
  confirmInvestmentCryptoTransfer,
  listAccountIncomeEvents,
  listInvestmentCryptoTransfers,
  listInvestmentImportProfiles,
  listInvestmentIngestionSourceRecords,
  listInvestmentImports,
  listInvestmentReconciliationItems,
  previewInvestmentImport,
  resolveInvestmentReconciliationItem,
  revertInvestmentImport,
  type InvestmentAccount,
  type InvestmentImportMapping,
  type InvestmentImportPreview,
  type InvestmentImportRequest,
  type InvestmentImportRun,
  type InvestmentCryptoTransfer,
  type InvestmentIncomeEvent,
  type InvestmentReconciliationItem,
  type InvestmentSourceRecord,
} from "@/lib/api/investments";
import { detectCsvDelimiter, parseDelimitedText } from "@/lib/import/parsing";
import {
  EMPTY_INVESTMENT_IMPORT_MAPPING,
  INVESTMENT_IMPORT_FIELDS,
  reconcileSavedInvestmentMapping,
  suggestInvestmentImportMapping,
} from "@/lib/investment-import/mapping";
import { CsvUploadDropzone } from "@/components/transactions/csv-upload-dropzone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type BusyState = "profiles" | "preview" | "import" | "history" | "revert" | "reconcile" | "provenance" | null;

function formattedDate(value: string): string {
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function InvestmentImportWizard({ accounts }: { accounts: InvestmentAccount[] }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [provider, setProvider] = useState("generic");
  const [fileName, setFileName] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<InvestmentImportMapping>(EMPTY_INVESTMENT_IMPORT_MAPPING);
  const [dateFormat, setDateFormat] = useState<InvestmentImportRequest["date_format"]>("AUTO");
  const [amountFormat, setAmountFormat] = useState<InvestmentImportRequest["amount_format"]>("AUTO");
  const [assetType, setAssetType] = useState<InvestmentImportRequest["default_asset_type"]>("equity");
  const [incomeDataKind, setIncomeDataKind] = useState<NonNullable<InvestmentImportRequest["income_data_kind"]>>("cash_activity");
  const [defaultCurrency, setDefaultCurrency] = useState(accounts[0]?.base_currency ?? "AUD");
  const [saveMapping, setSaveMapping] = useState(true);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<InvestmentImportPreview | null>(null);
  const [runs, setRuns] = useState<InvestmentImportRun[]>([]);
  const [cryptoTransfers, setCryptoTransfers] = useState<InvestmentCryptoTransfer[]>([]);
  const [reconciliationItems, setReconciliationItems] = useState<InvestmentReconciliationItem[]>([]);
  const [incomeEvents, setIncomeEvents] = useState<InvestmentIncomeEvent[]>([]);
  const [selectedIncomeEvents, setSelectedIncomeEvents] = useState<Record<string, string>>({});
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [sourceRecordsByRun, setSourceRecordsByRun] = useState<Record<string, InvestmentSourceRecord[]>>({});
  const [busy, setBusy] = useState<BusyState>(null);
  const [error, setError] = useState<string | null>(null);
  const [completedMessage, setCompletedMessage] = useState<string | null>(null);

  const account = accounts.find((item) => item.id === accountId);
  const providerKey = provider.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  const isSuperhero = providerKey === "superhero";
  const isCryptoComApp = providerKey === "cryptocom" || providerKey === "cryptocomapp";

  const requestPayload = useCallback((): InvestmentImportRequest => ({
    account_id: accountId,
    provider: provider.trim(),
    file_name: fileName,
    file_content: fileContent,
    mapping,
    date_format: dateFormat,
    amount_format: amountFormat,
    default_asset_type: assetType,
    default_currency: defaultCurrency.trim().toUpperCase() || account?.base_currency || "AUD",
    income_data_kind: incomeDataKind,
  }), [account?.base_currency, accountId, amountFormat, assetType, dateFormat, defaultCurrency, fileContent, fileName, incomeDataKind, mapping, provider]);

  const loadHistory = useCallback(async () => {
    if (!accountId) return;
    setBusy((current) => current ?? "history");
    try {
      const [history, pending, events, transfers] = await Promise.all([
        listInvestmentImports(accountId),
        listInvestmentReconciliationItems(accountId),
        listAccountIncomeEvents(accountId),
        listInvestmentCryptoTransfers(accountId),
      ]);
      setRuns(history);
      setReconciliationItems(pending);
      setIncomeEvents(events);
      setCryptoTransfers(transfers);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load import history.");
    } finally {
      setBusy((current) => current === "history" ? null : current);
    }
  }, [accountId]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (!accountId || !provider.trim()) return;
    let cancelled = false;
    setBusy((current) => current ?? "profiles");
    listInvestmentImportProfiles(accountId, provider, incomeDataKind)
      .then((profiles) => {
        if (cancelled || profiles.length === 0) {
          if (!cancelled) setProfileMessage(null);
          return;
        }
        const profile = profiles[0];
        if (headers.length > 0) {
          setMapping(reconcileSavedInvestmentMapping(profile.mapping.columns, headers));
        }
        setDateFormat(profile.mapping.date_format ?? "AUTO");
        setAmountFormat(profile.mapping.amount_format ?? "AUTO");
        setAssetType(profile.mapping.default_asset_type ?? "equity");
        setDefaultCurrency(profile.mapping.default_currency ?? account?.base_currency ?? "AUD");
        setIncomeDataKind(profile.mapping.income_data_kind ?? "cash_activity");
        setProfileMessage(`Using saved mapping: ${profile.name}`);
      })
      .catch(() => {
        if (!cancelled) setProfileMessage(null);
      })
      .finally(() => {
        if (!cancelled) setBusy((current) => current === "profiles" ? null : current);
      });
    return () => { cancelled = true; };
  }, [account?.base_currency, accountId, headers, incomeDataKind, provider]);

  const onFileSelect = useCallback((file: File, content: string) => {
    const parsed = parseDelimitedText(content, detectCsvDelimiter(content));
    setFileName(file.name);
    setFileContent(content);
    setHeaders(parsed.headers);
    setMapping(suggestInvestmentImportMapping(parsed.headers, provider));
    if (isCryptoComApp) {
      setAssetType("crypto");
      setIncomeDataKind("cash_activity");
      setAmountFormat("DOT_DECIMAL");
    }
    setPreview(null);
    setCompletedMessage(null);
    setError(parsed.headers.length ? null : "The file has no header row.");
  }, [isCryptoComApp, provider]);

  const missingRequired = useMemo(
    () => INVESTMENT_IMPORT_FIELDS.filter((field) => field.required && !mapping[field.key]),
    [mapping],
  );

  const runPreview = async () => {
    if (!accountId || !fileContent || !provider.trim() || missingRequired.length > 0) {
      setError("Choose an account and file, then map Date, Activity type, and Symbol.");
      return;
    }
    setBusy("preview");
    setError(null);
    setCompletedMessage(null);
    try {
      setPreview(await previewInvestmentImport(requestPayload()));
    } catch (cause) {
      setPreview(null);
      setError(cause instanceof Error ? cause.message : "Preview failed.");
    } finally {
      setBusy(null);
    }
  };

  const applyImport = async () => {
    if (!preview || preview.summary.ready_rows === 0) return;
    setBusy("import");
    setError(null);
    try {
      const result = await applyInvestmentImport({
        ...requestPayload(),
        save_mapping: saveMapping,
        mapping_name: `${provider.trim()} investment mapping`,
      });
      setCompletedMessage(
        `Imported ${result.inserted_activities} activit${result.inserted_activities === 1 ? "y" : "ies"}. ` +
        `${result.skipped_duplicate_records} duplicate source record${result.skipped_duplicate_records === 1 ? " was" : "s were"} skipped.`,
      );
      toast.success("Investment import completed");
      setPreview(await previewInvestmentImport(requestPayload()));
      await loadHistory();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Import failed.");
      toast.error("Investment import failed");
    } finally {
      setBusy(null);
    }
  };

  const undoRun = async (run: InvestmentImportRun) => {
    if (!window.confirm(`Undo ${run.source_name ?? "this import"}? Other import batches will remain.`)) return;
    setBusy("revert");
    setError(null);
    try {
      const result = await revertInvestmentImport(run.id);
      toast.success(`Import undone: ${result.removed_trades} trades and ${result.removed_income_events} income events removed.`);
      await loadHistory();
      if (fileContent) setPreview(await previewInvestmentImport(requestPayload()));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not undo the import.");
    } finally {
      setBusy(null);
    }
  };

  const toggleProvenance = async (run: InvestmentImportRun) => {
    if (expandedRunId === run.id) {
      setExpandedRunId(null);
      return;
    }
    setExpandedRunId(run.id);
    if (sourceRecordsByRun[run.id]) return;
    setBusy("provenance");
    try {
      const records = await listInvestmentIngestionSourceRecords(run.id);
      setSourceRecordsByRun((current) => ({ ...current, [run.id]: records }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load provenance.");
    } finally {
      setBusy(null);
    }
  };

  const resolveItem = async (
    item: InvestmentReconciliationItem,
    payload: Parameters<typeof resolveInvestmentReconciliationItem>[1],
  ) => {
    setBusy("reconcile");
    setError(null);
    try {
      await resolveInvestmentReconciliationItem(item.id, payload);
      toast.success("Reconciliation updated");
      await loadHistory();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update reconciliation.");
    } finally {
      setBusy(null);
    }
  };

  const confirmTransfer = async (transferId: string, candidateId: string) => {
    setBusy("reconcile");
    setError(null);
    try {
      await confirmInvestmentCryptoTransfer(transferId, candidateId);
      toast.success("Transfer pair confirmed; original lot basis was preserved.");
      await loadHistory();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not confirm transfer.");
    } finally {
      setBusy(null);
    }
  };

  if (accounts.length === 0) {
    return (
      <Card className="rounded-none">
        <CardContent className="p-6 text-sm text-muted-foreground">
          Create a manual investment account first, then return here to import its broker or exchange statement.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <Card className="rounded-none">
        <CardHeader><CardTitle className="text-base">1. Source and account</CardTitle></CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 md:grid-cols-4">
            <div className="space-y-2">
              <Label>Investment account</Label>
              <Select value={accountId} onValueChange={(value) => value && setAccountId(value)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{accounts.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>File contents</Label>
              <Select value={incomeDataKind} onValueChange={(value) => value && setIncomeDataKind(value as typeof incomeDataKind)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash_activity">Cash-year activity</SelectItem>
                  <SelectItem value="annual_statement">Final annual tax statement</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="investment-import-provider">Provider</Label>
              <Input
                id="investment-import-provider"
                list="investment-import-providers"
                value={provider}
                onChange={(event) => {
                  const value = event.target.value;
                  setProvider(value);
                  if (headers.length > 0) setMapping(suggestInvestmentImportMapping(headers, value));
                  const key = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
                  if (key === "cryptocom" || key === "cryptocomapp") {
                    setAssetType("crypto");
                    setIncomeDataKind("cash_activity");
                    setAmountFormat("DOT_DECIMAL");
                  }
                }}
                placeholder="Broker or exchange name"
              />
              <datalist id="investment-import-providers"><option value="Crypto.com App" /><option value="Superhero" /><option value="Generic" /></datalist>
            </div>
            <div className="space-y-2">
              <Label htmlFor="investment-import-currency">Default currency</Label>
              <Input id="investment-import-currency" value={defaultCurrency} onChange={(event) => setDefaultCurrency(event.target.value)} maxLength={16} />
            </div>
          </div>
          {isSuperhero && (
            <div className="space-y-2 border border-border bg-muted/20 p-4 text-xs text-muted-foreground">
              <div className="font-medium text-foreground">Superhero report guidance</div>
              <p>
                In Superhero, open Reports on the web, or Profile → Tax Reports in the app, and download CSV rather than PDF.
                Use a Transaction Statement for buys and sells, and an Income Report for dividends. Upload each report separately.
              </p>
              <p>
                The Full Portfolio Report does not include AMIT/AMMA data. Import the separate AMIT/AMMA statement when Superhero makes it available.
                Superhero does not offer DRP, so its income rows should not be mapped as dividend reinvestments.
              </p>
              <p>
                Current CSV column schemas are not published by Superhero, so review the suggested mapping before preview.
                See <a className="underline underline-offset-2" href="https://www.superhero.com.au/support/articles/13648478865167-tax-reporting/" target="_blank" rel="noreferrer">Tax Reporting</a>
                {" and "}<a className="underline underline-offset-2" href="https://support.superhero.com.au/hc/en-au/articles/14787654257807-Dividends" target="_blank" rel="noreferrer">Dividends</a>.
              </p>
            </div>
          )}
          {isCryptoComApp && (
            <div className="space-y-2 border border-border bg-muted/20 p-4 text-xs text-muted-foreground">
              <div className="font-medium text-foreground">Crypto.com App preset</div>
              <p>
                Export the original Token Wallet CSV from Accounts → History → Export. The preset reads Crypto.com transaction kinds,
                pairs supported conversion rows, and uses Native Amount only when Native Currency is AUD.
              </p>
              <p>The mapped columns below are shown for audit; this preset validates and interprets the provider schema directly.</p>
              <p>
                Cash-wallet-only movements, card cashback or reimbursements, lock/stake bookkeeping, and unknown transaction kinds stay rejected for review.
                Import a complete history so later disposals retain their acquisition cost base; each App report can cover up to three years.
              </p>
              <p>
                Crypto.com Exchange and Onchain exports use different formats and are not accepted by this App preset. See the{" "}
                <a className="underline underline-offset-2" href="https://help.crypto.com/en/articles/3438579-how-do-i-export-my-transaction-history-app" target="_blank" rel="noreferrer">official App export guide</a>.
              </p>
            </div>
          )}
          {incomeDataKind === "annual_statement" && (
            <div className="border border-amber-500/30 bg-amber-500/5 p-4 text-xs text-muted-foreground">
              Final statement rows enrich matching cash dividends and distributions; they do not create another income event.
              Map the AMIT cost-base shortfall as an increase and excess as a decrease. Unmatched or conflicting rows stay in reconciliation review.
            </div>
          )}
          {assetType === "crypto" && (
            <div className="border border-border bg-muted/20 p-4 text-xs text-muted-foreground">
              For swaps and rewards, map the event-time AUD market value and its source when available.
              For owned-wallet movements, map the blockchain transaction hash and the net quantity received;
              map any network fee separately so its disposal remains auditable.
            </div>
          )}
          <CsvUploadDropzone onFileSelect={onFileSelect} isUploading={busy === "preview" || busy === "import"} />
          {profileMessage && <p className="text-xs text-muted-foreground">{profileMessage}</p>}
        </CardContent>
      </Card>

      {headers.length > 0 && (
        <Card className="rounded-none">
          <CardHeader><CardTitle className="text-base">2. Map columns</CardTitle></CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-x-5 gap-y-3 md:grid-cols-2">
              {INVESTMENT_IMPORT_FIELDS.map((field) => (
                <div key={field.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-3">
                  <Label htmlFor={`investment-map-${field.key}`} className="text-xs">
                    {field.label}{field.required ? " *" : ""}
                  </Label>
                  <select
                    id={`investment-map-${field.key}`}
                    className="h-9 w-full border border-input bg-background px-3 text-sm outline-none focus:border-ring"
                    value={mapping[field.key] ?? ""}
                    onChange={(event) => setMapping((current) => ({ ...current, [field.key]: event.target.value || null }))}
                  >
                    <option value="">Not mapped</option>
                    {headers.map((header) => <option key={header} value={header}>{header}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <div className="grid gap-4 border-t border-border pt-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label>Date format</Label>
                <Select value={dateFormat} onValueChange={(value) => value && setDateFormat(value as InvestmentImportRequest["date_format"])}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="AUTO">Auto-detect; reject ambiguous</SelectItem>
                    <SelectItem value="DD-MM-YYYY">Day first (DD-MM-YYYY)</SelectItem>
                    <SelectItem value="MM-DD-YYYY">Month first (MM-DD-YYYY)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Number format</Label>
                <Select value={amountFormat} onValueChange={(value) => value && setAmountFormat(value as InvestmentImportRequest["amount_format"])}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="AUTO">Auto-detect; reject ambiguous</SelectItem>
                    <SelectItem value="DOT_DECIMAL">1,234.56</SelectItem>
                    <SelectItem value="COMMA_DECIMAL">1.234,56</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Default asset type</Label>
                <Select value={assetType} onValueChange={(value) => value && setAssetType(value as InvestmentImportRequest["default_asset_type"])}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="equity">Equity</SelectItem>
                    <SelectItem value="fund">Fund / ETF</SelectItem>
                    <SelectItem value="crypto">Crypto</SelectItem>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="option">Option</SelectItem>
                    <SelectItem value="bond">Bond</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button onClick={runPreview} disabled={busy !== null || missingRequired.length > 0}>
              {busy === "preview" && <RiLoader4Line className="size-4 animate-spin" />} Preview import
            </Button>
          </CardContent>
        </Card>
      )}

      {error && (
        <div role="alert" className="flex gap-2 border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          <RiAlertLine className="mt-0.5 size-4 shrink-0" /> {error}
        </div>
      )}
      {completedMessage && (
        <div className="flex gap-2 border border-emerald-500/40 bg-emerald-500/5 p-4 text-sm text-emerald-700 dark:text-emerald-300">
          <RiCheckLine className="mt-0.5 size-4 shrink-0" /> {completedMessage}
        </div>
      )}

      {preview && (
        <Card className="rounded-none">
          <CardHeader><CardTitle className="text-base">3. Dry-run preview</CardTitle></CardHeader>
          <CardContent className="space-y-5">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
              {[
                ["Ready", preview.summary.ready_rows],
                ["Duplicates", preview.summary.duplicate_rows],
                ["Rejected", preview.summary.rejected_rows],
                ["Source conflicts", preview.summary.conflict_rows],
                ["Warnings", preview.summary.warning_rows],
                ["Total", preview.summary.total_rows],
              ].map(([label, value]) => (
                <div key={String(label)} className="border border-border p-3">
                  <div className="text-xl font-semibold tabular-nums">{value}</div>
                  <div className="text-xs text-muted-foreground">{label}</div>
                </div>
              ))}
            </div>
            {preview.unmatched_assets.length > 0 && (
              <div className="border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-200">
                New assets will be created from valid activity: {preview.unmatched_assets.join(", ")}.
              </div>
            )}
            <div className="overflow-x-auto border border-border">
              <table className="w-full text-left text-xs">
                <thead className="bg-muted/50 text-muted-foreground"><tr>
                  <th className="p-2 font-medium">Row</th><th className="p-2 font-medium">Status</th><th className="p-2 font-medium">Date</th>
                  <th className="p-2 font-medium">Activity</th><th className="p-2 font-medium">Asset</th><th className="p-2 font-medium">Quantity</th>
                  <th className="p-2 font-medium">Amount / price</th><th className="p-2 font-medium">Currency</th><th className="p-2 font-medium">Notes</th>
                </tr></thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.row_number} className="border-t border-border align-top">
                      <td className="p-2 tabular-nums">{row.row_number}</td>
                      <td className="p-2"><Badge variant={row.status === "ready" ? "secondary" : "outline"}>{row.status}</Badge></td>
                      <td className="p-2 whitespace-nowrap">{String(row.normalized.occurred_at ?? "")}</td>
                      <td className="p-2">{String(row.normalized.activity_type ?? "")}</td>
                      <td className="p-2 font-medium">{String(row.normalized.asset_symbol ?? "")}{row.asset_status === "new" ? " · new" : ""}</td>
                      <td className="p-2 tabular-nums">{String(row.normalized.quantity ?? "—")}</td>
                      <td className="p-2 tabular-nums">{String(row.normalized.net_amount ?? row.normalized.gross_amount ?? row.normalized.price ?? "—")}</td>
                      <td className="p-2">{String(row.normalized.currency ?? "—")}</td>
                      <td className="max-w-64 p-2 text-muted-foreground">{row.conflict_reason ?? row.duplicate_reason ?? row.warnings.join("; ")}</td>
                    </tr>
                  ))}
                  {preview.rejected_rows.map((row) => (
                    <tr key={`rejected-${row.row_number}`} className="border-t border-border bg-destructive/5 align-top">
                      <td className="p-2 tabular-nums">{row.row_number}</td>
                      <td className="p-2"><Badge variant="destructive">rejected</Badge></td>
                      <td className="p-2" colSpan={7}>{row.reasons.join("; ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox checked={saveMapping} onCheckedChange={(checked) => setSaveMapping(checked === true)} />
                Save this mapping for {provider.trim() || "this provider"} and account
              </label>
              <Button onClick={applyImport} disabled={busy !== null || preview.summary.ready_rows === 0}>
                {busy === "import" && <RiLoader4Line className="size-4 animate-spin" />}
                Import {preview.summary.ready_rows} ready row{preview.summary.ready_rows === 1 ? "" : "s"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="rounded-none">
        <CardHeader><CardTitle className="text-base">Crypto transfer review</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            A transfer is excluded from CGT only after a unique matching movement is found in another owned account. Network fees remain separate disposals.
          </p>
          {cryptoTransfers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No crypto transfer activity is recorded for this account.</p>
          ) : (
            <div className="divide-y divide-border border border-border">
              {cryptoTransfers.map((transfer) => (
                <div className="grid gap-2 p-3 text-xs md:grid-cols-[minmax(0,1fr)_auto]" key={transfer.id}>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{transfer.direction === "in" ? "Received" : transfer.direction === "out" ? "Sent" : "Internal"} {transfer.quantity} {transfer.asset_symbol}</span>
                      <Badge className={transfer.status === "ambiguous" ? "border-amber-500/50 text-amber-700 dark:text-amber-300" : undefined} variant="outline">{transfer.status}</Badge>
                    </div>
                    <p className="mt-1 text-muted-foreground">{formattedDate(transfer.occurred_at)} · {transfer.reason ?? "No matching detail was recorded."}</p>
                    {transfer.transaction_hash && <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={transfer.transaction_hash}>Transaction {transfer.transaction_hash}</p>}
                  </div>
                  <div className="text-muted-foreground md:text-right">
                    <div>
                      {transfer.match_method === "user_confirmed"
                        ? "User-confirmed match"
                        : transfer.match_method === "transaction_hash"
                          ? "Matched by transaction hash"
                          : transfer.match_method === "quantity_time_window"
                            ? "Matched by quantity and time"
                            : transfer.confidence
                              ? `${transfer.confidence} confidence suggestion`
                              : "Review required"}
                    </div>
                    {transfer.status === "ambiguous" && transfer.candidate_transfers.length > 0 && (
                      <div className="mt-2 flex flex-col gap-1.5 md:items-end">
                        {transfer.candidate_transfers.map((candidate) => (
                          <Button
                            key={candidate.id}
                            variant="outline"
                            size="sm"
                            disabled={busy !== null}
                            onClick={() => void confirmTransfer(transfer.id, candidate.id)}
                          >
                            Confirm {candidate.account_name} · {candidate.confidence}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-none">
        <CardHeader><CardTitle className="text-base">Reconciliation review</CardTitle></CardHeader>
        <CardContent>
          {reconciliationItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No unmatched or conflicting investment records need review.</p>
          ) : (
            <div className="divide-y divide-border border border-border">
              {reconciliationItems.map((item) => {
                const candidateEvents = item.candidate_income_event_ids.length > 0
                  ? incomeEvents.filter((event) => item.candidate_income_event_ids.includes(event.id))
                  : incomeEvents;
                const selectedEvent = selectedIncomeEvents[item.id] ?? candidateEvents[0]?.id ?? "";
                const conflicts = item.details.conflicts && typeof item.details.conflicts === "object"
                  ? item.details.conflicts as Record<string, unknown>
                  : {};
                const hasUnsafeCostBaseConflict = "cost_base_adjustment" in conflicts;
                const isCashTransfer = item.details.workflow === "investment_cash_transfer";
                const candidateActivityIds = Array.isArray(item.details.candidate_activity_ids)
                  ? item.details.candidate_activity_ids.filter((value): value is string => typeof value === "string")
                  : [];
                return (
                  <div key={item.id} className="space-y-3 p-3 text-xs">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div><Badge variant="outline">{item.kind.replaceAll("_", " ")}</Badge><p className="mt-2 text-muted-foreground">{item.reason}</p></div>
                      <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void resolveItem(item, { action: "ignore" })}>Ignore</Button>
                    </div>
                    {item.kind === "cash_match" && item.candidate_transaction_ids.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {item.candidate_transaction_ids.map((transactionId) => (
                          <Button key={transactionId} variant="outline" size="sm" disabled={busy !== null} onClick={() => void resolveItem(item, { action: "link_transaction", transaction_id: transactionId })}>
                            {isCashTransfer ? "Confirm bank movement" : "Link cash credit"} {transactionId.slice(0, 8)}
                          </Button>
                        ))}
                      </div>
                    )}
                    {isCashTransfer && candidateActivityIds.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {candidateActivityIds.map((activityId) => (
                          <Button key={activityId} variant="outline" size="sm" disabled={busy !== null} onClick={() => void resolveItem(item, { action: "link_activity", activity_id: activityId })}>
                            Confirm brokerage movement {activityId.slice(0, 8)}
                          </Button>
                        ))}
                      </div>
                    )}
                    {item.kind === "annual_statement" && candidateEvents.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2">
                        <Select value={selectedEvent} onValueChange={(value) => value && setSelectedIncomeEvents((current) => ({ ...current, [item.id]: value }))}>
                          <SelectTrigger className="w-72"><SelectValue /></SelectTrigger>
                          <SelectContent>{candidateEvents.map((event) => <SelectItem key={event.id} value={event.id}>{event.pay_date} · {event.event_type} · {event.cash_received} {event.currency}</SelectItem>)}</SelectContent>
                        </Select>
                        <Button variant="outline" size="sm" disabled={busy !== null || !selectedEvent} onClick={() => void resolveItem(item, { action: "link_income_event", income_event_id: selectedEvent })}>Link and enrich</Button>
                      </div>
                    )}
                    {item.kind === "component_conflict" && (
                      <div className="space-y-2">
                        {hasUnsafeCostBaseConflict && (
                          <p className="text-amber-700 dark:text-amber-300">This cost-base decrease may create CGT event E10. Keep the recorded values and review it outside automatic reconciliation.</p>
                        )}
                        <div className="flex flex-wrap gap-2">
                          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void resolveItem(item, { action: "keep_existing" })}>Keep recorded values</Button>
                          {!hasUnsafeCostBaseConflict && (
                            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void resolveItem(item, { action: "apply_statement" })}>Use statement values</Button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-none">
        <CardHeader><CardTitle className="text-base">Import history</CardTitle></CardHeader>
        <CardContent>
          {busy === "history" && runs.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><RiLoader4Line className="size-4 animate-spin" /> Loading history…</div>
          ) : runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No statement imports for this account yet.</p>
          ) : (
            <div className="divide-y divide-border border border-border">
              {runs.map((run) => (
                <div key={run.id} className="space-y-2 p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 font-medium"><span>{run.source_name ?? "Investment import"}</span><Badge variant="outline">{run.status}</Badge></div>
                      <div className="mt-1 text-muted-foreground">{run.provider} · {formattedDate(run.started_at)} · {String(run.summary.inserted_activities ?? 0)} activities</div>
                      {run.error && <div className="mt-1 text-destructive">{run.error}</div>}
                    </div>
                    <div className="flex gap-2">
                      <Button variant="ghost" size="sm" onClick={() => void toggleProvenance(run)} disabled={busy !== null}>
                        {expandedRunId === run.id ? "Hide provenance" : "View provenance"}
                      </Button>
                      {(run.status === "completed" || run.status === "partial") && (
                        <Button variant="outline" size="sm" onClick={() => void undoRun(run)} disabled={busy !== null}>
                          <RiDeleteBinLine className="size-4" /> Undo batch
                        </Button>
                      )}
                    </div>
                  </div>
                  {expandedRunId === run.id && (
                    <div className="max-h-64 space-y-2 overflow-auto border border-border bg-muted/20 p-2">
                      {(sourceRecordsByRun[run.id] || []).map((record) => (
                        <details key={record.id}>
                          <summary className="cursor-pointer font-mono text-[11px]">
                            {record.occurred_at} · {record.provider_record_id ?? record.id.slice(0, 8)}
                          </summary>
                          <pre className="mt-1 overflow-auto whitespace-pre-wrap text-[10px] text-muted-foreground">
                            {JSON.stringify({ payload: record.source_payload, metadata: record.source_metadata }, null, 2)}
                          </pre>
                        </details>
                      ))}
                      {busy === "provenance" && <div className="text-muted-foreground">Loading provenance…</div>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
