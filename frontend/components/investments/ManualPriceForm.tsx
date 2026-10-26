"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveManualPrice, type Holding } from "@/lib/api/investments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ManualPriceForm({ holding }: { holding: Holding }) {
  const router = useRouter();
  const [price, setPrice] = useState("");
  const [date, setDate] = useState(new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Brisbane" }));
  const [currency, setCurrency] = useState(holding.currency);
  const [source, setSource] = useState("Fund statement");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <form className="rounded-md border p-4 space-y-3" onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      await saveManualPrice(holding.id, { date, price, currency, source });
      router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Price update failed"); }
    finally { setBusy(false); }
  }}>
    <p className="text-sm font-medium">Record a dated unit price / NAV</p>
    <p className="text-xs text-muted-foreground">Used instead of automatic market prices for this holding. Enter the price per unit and the source shown on your statement.</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <div><Label htmlFor="nav-price">Price per unit</Label><Input id="nav-price" type="number" min="0" step="any" value={price} onChange={(e) => setPrice(e.target.value)} required /></div>
      <div><Label htmlFor="nav-date">Price date</Label><Input id="nav-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></div>
      <div><Label htmlFor="nav-currency">Price currency</Label><Input id="nav-currency" maxLength={3} pattern="[A-Z]{3}" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} required /></div>
      <div><Label htmlFor="nav-source">Source</Label><Input id="nav-source" maxLength={20} value={source} onChange={(e) => setSource(e.target.value)} required /></div>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button disabled={busy} type="submit">{busy ? "Saving…" : "Save unit price"}</Button>
  </form>;
}
