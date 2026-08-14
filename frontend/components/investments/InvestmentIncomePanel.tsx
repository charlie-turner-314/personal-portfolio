"use client";

import { useState } from "react";
import { RiAddLine } from "@remixicon/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { currencySymbol } from "@/lib/utils/currency";
import { InvestmentIncomeCsvImport } from "./InvestmentIncomeCsvImport";
import type { CreateInvestmentIncomeEvent, InvestmentIncomeEvent, InvestmentIncomeTotals } from "./income-types";
type IncomeFormInput = Omit<CreateInvestmentIncomeEvent, "account_id" | "holding_id">;

function amount(value: string | null | undefined, currency: string) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return "Not provided";
  return `${currencySymbol(currency)} ${parsed.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function optional(value: string | null | undefined, currency: string) {
  return value == null || value === "" ? "Not provided" : amount(value, currency);
}

const initialForm: IncomeFormInput = {
  event_type: "dividend",
  pay_date: "",
  currency: "AUD",
  cash_received: "",
  is_drp: false,
};

export function InvestmentIncomePanel({
  events = [],
  totals,
  defaultCurrency,
  onCreate,
}: {
  events?: InvestmentIncomeEvent[];
  totals?: InvestmentIncomeTotals;
  defaultCurrency: string;
  onCreate?: (event: IncomeFormInput) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<IncomeFormInput>({ ...initialForm, currency: defaultCurrency });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!onCreate) return;
    setSaving(true);
    setError(null);
    try {
      await onCreate(form);
      setOpen(false);
      setForm({ ...initialForm, currency: defaultCurrency });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save income event.");
    } finally {
      setSaving(false);
    }
  };

  return <>
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 p-4 pb-0">
        <div>
          <CardTitle className="text-sm">Income</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">Statement amounts are shown as recorded; they are not tax advice.</p>
        </div>
        {onCreate && <Button size="sm" onClick={() => setOpen(true)}><RiAddLine className="size-4" />Add income</Button>}
      </CardHeader>
      <CardContent className="p-4">
        {totals && <dl className="mb-4 grid grid-cols-2 gap-3 border-b pb-4 text-sm md:grid-cols-4">
          <div><dt className="text-xs text-muted-foreground">Cash received</dt><dd className="mt-1 font-medium tabular-nums">{amount(totals.cash_received, totals.currency)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Franking credits</dt><dd className="mt-1 font-medium tabular-nums">{amount(totals.franking_credits, totals.currency)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Foreign income</dt><dd className="mt-1 font-medium tabular-nums">{amount(totals.foreign_income, totals.currency)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Foreign tax paid</dt><dd className="mt-1 font-medium tabular-nums">{amount(totals.foreign_tax_paid, totals.currency)}</dd></div>
        </dl>}
        {events.length === 0 ? <p className="text-sm text-muted-foreground">No dividend or distribution income recorded for this holding.</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground"><th className="py-2 pr-4">Pay date</th><th className="py-2 pr-4">Type</th><th className="py-2 pr-4 text-right">Cash</th><th className="py-2 pr-4 text-right">Franking credit</th><th className="py-2 pr-4 text-right">Foreign tax</th><th className="py-2 pr-4">AMIT/AMMA</th></tr></thead><tbody>{events.map((income) => <tr key={income.id} className="border-b last:border-b-0"><td className="py-2 pr-4 tabular-nums">{income.pay_date}</td><td className="py-2 pr-4 capitalize">{income.event_type}{income.is_drp ? " · DRP" : ""}</td><td className="py-2 pr-4 text-right tabular-nums">{amount(income.cash_received, income.currency)}</td><td className="py-2 pr-4 text-right tabular-nums">{optional(income.franking_credit, income.currency)}</td><td className="py-2 pr-4 text-right tabular-nums">{optional(income.foreign_tax_paid, income.currency)}</td><td className="py-2 pr-4 text-muted-foreground">{income.amit_amma_components && Object.keys(income.amit_amma_components).length > 0 ? "Provided" : "Not provided"}</td></tr>)}</tbody></table></div>}
        {onCreate && <InvestmentIncomeCsvImport defaultCurrency={defaultCurrency} existingEvents={events} onCreate={onCreate} />}
      </CardContent>
    </Card>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>Add investment income</DialogTitle></DialogHeader><form className="space-y-4" onSubmit={submit}>
      <div className="grid grid-cols-2 gap-3"><div className="space-y-2"><Label htmlFor="income-type">Type</Label><Select value={form.event_type} onValueChange={(value) => value && setForm((current) => ({ ...current, event_type: value }))}><SelectTrigger id="income-type"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="dividend">Dividend</SelectItem><SelectItem value="distribution">Distribution</SelectItem></SelectContent></Select></div><div className="space-y-2"><Label htmlFor="income-pay-date">Pay date</Label><Input id="income-pay-date" type="date" required value={form.pay_date} onChange={(event) => setForm((current) => ({ ...current, pay_date: event.target.value }))} /></div></div>
      <div className="grid grid-cols-2 gap-3"><div className="space-y-2"><Label htmlFor="income-cash">Cash received</Label><Input id="income-cash" type="number" min="0" step="0.01" required value={form.cash_received} onChange={(event) => setForm((current) => ({ ...current, cash_received: event.target.value }))} /></div><div className="space-y-2"><Label htmlFor="income-currency">Currency</Label><Input id="income-currency" required maxLength={3} value={form.currency} onChange={(event) => setForm((current) => ({ ...current, currency: event.target.value.toUpperCase() }))} /></div></div>
      <div className="grid grid-cols-2 gap-3"><MoneyField id="income-franked" label="Franked amount" value={form.franked_amount} onChange={(value) => setForm((current) => ({ ...current, franked_amount: value }))} /><MoneyField id="income-unfranked" label="Unfranked amount" value={form.unfranked_amount} onChange={(value) => setForm((current) => ({ ...current, unfranked_amount: value }))} /><MoneyField id="income-franking-credit" label="Franking credit" value={form.franking_credit} onChange={(value) => setForm((current) => ({ ...current, franking_credit: value }))} /><MoneyField id="income-foreign-income" label="Foreign income" value={form.foreign_income} onChange={(value) => setForm((current) => ({ ...current, foreign_income: value }))} /><MoneyField id="income-foreign-tax" label="Foreign tax paid" value={form.foreign_tax_paid} onChange={(value) => setForm((current) => ({ ...current, foreign_tax_paid: value }))} /></div>
      <div className="flex items-center gap-2"><Checkbox id="income-drp" checked={form.is_drp} onCheckedChange={(checked) => setForm((current) => ({ ...current, is_drp: checked === true, ...(checked === true ? {} : { drp_quantity: undefined, drp_price: undefined }) }))} /><Label htmlFor="income-drp">Reinvested through DRP</Label></div>
      {form.is_drp && <div className="grid grid-cols-2 gap-3"><div className="space-y-2"><Label htmlFor="income-drp-quantity">DRP quantity</Label><Input id="income-drp-quantity" type="number" min="0.00000001" step="0.00000001" required value={form.drp_quantity ?? ""} onChange={(event) => setForm((current) => ({ ...current, drp_quantity: event.target.value }))} /></div><div className="space-y-2"><Label htmlFor="income-drp-price">DRP price</Label><Input id="income-drp-price" type="number" min="0" step="0.00000001" required value={form.drp_price ?? ""} onChange={(event) => setForm((current) => ({ ...current, drp_price: event.target.value }))} /></div></div>}
      <div className="space-y-2"><Label htmlFor="income-notes">Notes</Label><Textarea id="income-notes" value={form.notes ?? ""} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} /></div>
      {error && <p className="text-sm text-destructive">{error}</p>}<DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button><Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save income"}</Button></DialogFooter>
    </form></DialogContent></Dialog>
  </>;
}

function MoneyField({ id, label, value, onChange }: { id: string; label: string; value?: string | null; onChange: (value: string) => void }) {
  return <div className="space-y-2"><Label htmlFor={id}>{label}</Label><Input id={id} type="number" min="0" step="0.01" value={value ?? ""} onChange={(event) => onChange(event.target.value)} /></div>;
}
