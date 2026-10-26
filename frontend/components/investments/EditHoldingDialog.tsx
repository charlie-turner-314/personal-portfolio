"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateHolding, type Holding } from "@/lib/api/investments";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SymbolSearchInput } from "./SymbolSearchInput";
import type { SymbolSearchResult } from "@/lib/api/investments";

export function EditHoldingDialog({
  open,
  onOpenChange,
  holding,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  holding: Holding;
}) {
  const router = useRouter();
  const [symbol, setSymbol] = useState(holding.symbol);
  const [currency, setCurrency] = useState(holding.currency);
  const [instrumentType, setInstrumentType] = useState(holding.instrument_type);
  const [qty, setQty] = useState(holding.quantity);
  const [avgCost, setAvgCost] = useState(holding.avg_cost ?? "");
  const [asOfDate, setAsOfDate] = useState(holding.as_of_date ?? "");
  const [providerSymbol, setProviderSymbol] = useState(holding.provider_symbol ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await updateHolding(holding.id, {
        ...(symbol !== holding.symbol ? { symbol } : {}),
        quantity: qty,
        ...(currency !== holding.currency ? { currency } : {}),
        ...(instrumentType !== holding.instrument_type ? { instrument_type: instrumentType as "equity" | "etf" | "fund" | "crypto" | "cash" } : {}),
        avg_cost: avgCost === "" ? null : avgCost,
        as_of_date: asOfDate === "" ? null : asOfDate,
        provider_symbol: providerSymbol === "" ? null : providerSymbol,
      });
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit holding · {holding.symbol}</DialogTitle>
          <DialogDescription>
            Manual and disconnected-broker positions can be corrected here. Original transaction records remain unchanged.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="symbol">Symbol</Label>
            <SymbolSearchInput
              id="symbol"
              value={symbol}
              onChange={setSymbol}
              onSelect={(r: SymbolSearchResult) => setSymbol(r.symbol)}
            />
            <p className="text-xs text-muted-foreground">
              Changing the symbol triggers an automatic re-pricing on save.
            </p>
          </div>
          {holding.source === "manual" && <div className="grid grid-cols-2 gap-3">
            <div><Label htmlFor="holding-currency">Holding currency</Label><Input id="holding-currency" value={currency} maxLength={3} pattern="[A-Z]{3}" onChange={(e) => setCurrency(e.target.value.toUpperCase())} required /></div>
            <div><Label htmlFor="holding-type">Instrument type</Label><select id="holding-type" className="block border bg-background p-2" value={instrumentType} onChange={(e) => setInstrumentType(e.target.value as Holding["instrument_type"])}>{["equity", "etf", "fund", "crypto", "cash"].map((type) => <option key={type} value={type}>{type === "fund" ? "Managed fund" : type}</option>)}</select></div>
          </div>}
          <div className="space-y-2">
            <Label htmlFor="qty">Quantity</Label>
            <Input
              id="qty"
              type="number"
              min="0"
              step="any"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="avg-cost">
              Avg cost <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="avg-cost"
              type="number"
              min="0"
              step="any"
              value={avgCost}
              onChange={(e) => setAvgCost(e.target.value)}
              placeholder="—"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="as-of">
              As of date <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="as-of"
              type="date"
              value={asOfDate}
              onChange={(e) => setAsOfDate(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="provider-symbol">
              Price lookup symbol{" "}
              <span className="text-muted-foreground">(optional)</span>
            </Label>
            <SymbolSearchInput
              id="provider-symbol"
              value={providerSymbol}
              onChange={setProviderSymbol}
              onSelect={(r: SymbolSearchResult) => setProviderSymbol(r.symbol)}
              placeholder="e.g. VAS.AX or AAPL"
            />
            <p className="text-xs text-muted-foreground">
              Override the ticker used for price lookups. Use an exchange-specific ticker, such as VAS.AX for an ASX listing.
            </p>
          </div>
          {err && <p className="text-sm text-destructive">{err}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
