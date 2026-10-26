"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { RiAddLine, RiCloseLine } from "@remixicon/react";
import {
  addManualHolding,
  createManualAccount,
  type InvestmentAccount,
  type SymbolSearchResult,
} from "@/lib/api/investments";
import { Button } from "@/components/ui/button";
import { SymbolSearchInput } from "./SymbolSearchInput";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import { Field, Input } from "./_form-bits";

import { INVESTMENT_CURRENCIES } from "@/lib/utils/currency";

const NEW = "__new__";
type Inst = "etf" | "equity" | "fund" | "crypto" | "cash";

type Row = {
  id: string;
  symbol: string;
  symbolConfirmed: boolean;
  qty: string;
  type: Inst;
  currency: string;
  currencyExplicit: boolean;
  avgCost: string;
  error: string | null;
};

let _rowSeq = 0;
function newRow(currency = "AUD"): Row {
  return {
    id: `r${++_rowSeq}`,
    symbol: "",
    symbolConfirmed: false,
    qty: "",
    type: "etf",
    currency,
    currencyExplicit: false,
    avgCost: "",
    error: null,
  };
}

export function ManualForm({
  accounts: allAccounts,
  onCancel,
  defaultCurrency = "AUD",
}: {
  accounts: InvestmentAccount[];
  onCancel: () => void;
  defaultCurrency?: string;
}) {
  const router = useRouter();
  const [creationKey] = useState(() => crypto.randomUUID());
  const [createdAccount, setCreatedAccount] = useState<InvestmentAccount | null>(null);
  const accounts = [...allAccounts.filter((a) => a.can_add_holdings ?? a.source === "manual"), ...(createdAccount ? [createdAccount] : [])];
  const [accountId, setAccountId] = useState<string>(accounts[0]?.id ?? NEW);
  const [newName, setNewName] = useState("My Brokerage");
  const [baseCcy, setBaseCcy] = useState(defaultCurrency);
  const [rows, setRows] = useState<Row[]>([newRow(accounts[0]?.base_currency ?? defaultCurrency)]);
  const [busy, setBusy] = useState(false);
  const [topErr, setTopErr] = useState<string | null>(null);

  const updateRow = (id: string, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const removeRow = (id: string) =>
    setRows((rs) => (rs.length === 1 ? rs : rs.filter((r) => r.id !== id)));
  const addRow = () => setRows((rs) => [...rs, newRow(accounts.find((a) => a.id === accountId)?.base_currency ?? baseCcy)]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setTopErr(null);
    setRows((rs) => rs.map((r) => ({ ...r, error: null })));

    const valid = rows.filter((r) => r.symbol.trim() || r.qty.trim() || r.avgCost.trim());
    if (valid.length === 0 || valid.some((r) => !r.symbol.trim() || !r.qty.trim() || !Number.isFinite(Number(r.qty)) || Number(r.qty) < 0 || (r.avgCost !== "" && (!Number.isFinite(Number(r.avgCost)) || Number(r.avgCost) < 0)))) {
      setTopErr("Complete every started row with a symbol, non-negative quantity and valid optional average cost.");
      setBusy(false);
      return;
    }

    const keys = valid.map((row) => `${row.symbol.trim().toUpperCase()}:${row.type}`);
    if (new Set(keys).size !== keys.length) { setTopErr("Use one row per symbol and instrument type."); setBusy(false); return; }
    try {
      let target = accountId;
      if (target === NEW) {
        target = (await createManualAccount(newName, baseCcy, creationKey)).account_id;
        setCreatedAccount({ id: target, name: newName, base_currency: baseCcy, source: "manual", can_add_holdings: true });
        setAccountId(target);
      }

      const results = await Promise.allSettled(
        valid.map((r) =>
          addManualHolding(target, {
            symbol: r.symbol.trim().toUpperCase(),
            quantity: r.qty,
            instrument_type: r.type,
            currency: r.currency,
            ...(r.avgCost ? { avg_cost: r.avgCost } : {}),
          }),
        ),
      );

      const failures = results
        .map((res, i) => ({ res, row: valid[i] }))
        .filter(({ res }) => res.status === "rejected");

      if (failures.length === 0) {
        router.push("/investments");
        return;
      }

      // Drop rows that succeeded (already saved on the backend); keep
      // failed rows with their error messages plus any rows that weren't
      // submitted because they were incomplete.
      const failedById = new Map(
        failures.map(({ res, row }) => {
          const reason = res.status === "rejected" ? res.reason : null;
          return [
            row.id,
            reason instanceof Error ? reason.message : String(reason),
          ];
        }),
      );
      const submittedIds = new Set(valid.map((r) => r.id));
      setRows((rs) =>
        rs
          .filter((r) => failedById.has(r.id) || !submittedIds.has(r.id))
          .map((r) =>
            failedById.has(r.id) ? { ...r, error: failedById.get(r.id)! } : r,
          ),
      );
      setTopErr(
        `${results.length - failures.length}/${results.length} holdings added. Fix the errors below to retry the rest.`,
      );
    } catch (e) {
      setTopErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-t-2 border-t-primary">
      <CardContent className="p-6 space-y-4">
        <form onSubmit={submit} className="space-y-4">
          <div className="text-sm font-semibold">Add holdings</div>

          <div className="flex gap-3">
            <Field label="Account" className="flex-1">
              <Select
                value={accountId}
                onValueChange={(v) => { if (v) { setAccountId(v); const currency = accounts.find((account) => account.id === v)?.base_currency ?? baseCcy; setRows((items) => items.map((row) => row.currencyExplicit ? row : { ...row, currency })); } }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>{accounts.find((a) => a.id === accountId) ? `${accounts.find((a) => a.id === accountId)!.name} · ${accounts.find((a) => a.id === accountId)!.base_currency}` : "+ Create new account…"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name} · {a.base_currency}
                    </SelectItem>
                  ))}
                  <SelectItem value={NEW}>+ Create new account…</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          {accountId === NEW && (
            <div className="flex gap-3">
              <Field label="New account name" className="flex-[2_1_0%]">
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </Field>
              <Field label="Base currency" className="flex-1">
                <Select
                  value={baseCcy}
                  onValueChange={(v) => { if (v) { setBaseCcy(v); setRows((items) => items.map((row) => row.currencyExplicit ? row : { ...row, currency: v })); } }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue>{baseCcy}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {INVESTMENT_CURRENCIES.map((ccy) => <SelectItem key={ccy} value={ccy}>{ccy}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          )}

          <div className="space-y-3">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              Holdings ({rows.length})
            </div>
            {rows.map((r, i) => (
              <HoldingRow
                key={r.id}
                row={r}
                index={i}
                canRemove={rows.length > 1}
                onChange={(patch) => updateRow(r.id, patch)}
                onRemove={() => removeRow(r.id)}
              />
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addRow}
              className="w-full"
            >
              <RiAddLine className="size-4" />
              Add another holding
            </Button>
          </div>

          {topErr && <div role="alert" className="text-destructive text-xs">{topErr}</div>}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy
                ? "Adding…"
                : `Add ${rows.length} holding${rows.length === 1 ? "" : "s"}`}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function HoldingRow({
  row,
  index,
  canRemove,
  onChange,
  onRemove,
}: {
  row: Row;
  index: number;
  canRemove: boolean;
  onChange: (patch: Partial<Row>) => void;
  onRemove: () => void;
}) {
  const symbolLabel = row.symbol ? (
    <span className="flex items-center gap-1.5">
      Symbol
      {row.symbolConfirmed ? (
        <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-px text-[9px] font-semibold tracking-wide text-emerald-700 dark:text-emerald-400">
          Search result
        </span>
      ) : (
        <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-px text-[9px] font-semibold tracking-wide text-amber-700 dark:text-amber-400">
          Manually entered
        </span>
      )}
    </span>
  ) : (
    "Symbol"
  );

  return (
    <div className="rounded border border-border p-3 space-y-3 relative">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          #{index + 1}
        </div>
        {canRemove && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onRemove}
            aria-label="Remove holding"
          >
            <RiCloseLine className="size-4" />
          </Button>
        )}
      </div>
      <div className="flex gap-3">
        <Field label={symbolLabel} className="flex-[2_1_0%]">
          <SymbolSearchInput
            value={row.symbol}
            onChange={(v) =>
              onChange({ symbol: v, symbolConfirmed: false })
            }
            onSelect={(r: SymbolSearchResult) =>
              onChange({
                symbol: r.symbol,
                symbolConfirmed: true,
                ...(r.currency ? { currency: r.currency, currencyExplicit: true } : {}),
                ...(r.instrument_type ? { type: r.instrument_type } : {}),
              })
            }
            placeholder="Search symbol or name…"
          />
        </Field>
      </div>
      <div className="flex gap-3">
        <Field label="Quantity" className="flex-1">
          <Input
            type="number"
            min="0"
            step="any"
            placeholder="0.00"
            value={row.qty}
            onChange={(e) => onChange({ qty: e.target.value })}
          />
        </Field>
        <Field label="Instrument type" className="flex-1">
          <ToggleGroup
            multiple={false}
            value={[row.type]}
            onValueChange={(v) =>
              v[0] && onChange({ type: v[0] as Inst })
            }
            variant="outline"
            size="sm"
          >
            {(["etf", "equity", "fund", "crypto", "cash"] as Inst[]).map((t) => (
              <ToggleGroupItem
                key={t}
                value={t}
                className="capitalize flex-1"
              >
                {t === "etf" ? "ETF" : t === "fund" ? "Managed fund" : t}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
        <Field label="Currency" className="flex-1">
          <Select
            value={row.currency}
            onValueChange={(v) => v && onChange({ currency: v, currencyExplicit: true })}
          >
            <SelectTrigger className="w-full">
              <SelectValue>{row.currency}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Array.from(new Set([...INVESTMENT_CURRENCIES, row.currency])).map((ccy) => <SelectItem key={ccy} value={ccy}>{ccy}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field
          label={
            <>
              Avg cost{" "}
              <span className="font-normal text-muted-foreground normal-case tracking-normal">
                (optional)
              </span>
            </>
          }
          className="flex-1"
        >
          <Input
            type="number"
            min="0"
            step="any"
            placeholder="—"
            value={row.avgCost}
            onChange={(e) => onChange({ avgCost: e.target.value })}
          />
        </Field>
      </div>
      {row.error && (
        <div className="text-destructive text-xs">{row.error}</div>
      )}
    </div>
  );
}
