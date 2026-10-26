"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateTransactionCashFlowPurpose } from "@/lib/actions/transactions";
import { validateCashFlowPortions, type CashFlowPortion } from "@/lib/dashboard/cash-flow";

interface Props {
  transactionId: string;
  amount: number;
  currency: string;
  parts?: CashFlowPortion[] | null;
  onSaved: (parts: CashFlowPortion[] | null) => void;
}
const choices = [
  ["income", "Income"], ["consumption", "Everyday expense / interest"],
  ["investment", "Capital: investment"], ["loan_principal", "Capital: loan principal"], ["other", "Capital: other asset or debt"],
];
function portion(value: string, amount: number): CashFlowPortion {
  return value === "income" || value === "consumption" ? { kind: value, amount }
    : { kind: "capital", detail: value as "investment" | "loan_principal" | "other", amount };
}
const key = (part: CashFlowPortion) => part.kind === "capital" ? part.detail! : part.kind;

export function CashFlowPurpose({ transactionId, amount, currency, parts, onSaved }: Props) {
  const router = useRouter();
  const [portions, setPortions] = useState<CashFlowPortion[] | null>(parts ?? null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const error = validateCashFlowPortions(portions, amount);
    if (error) { toast.error(error); return; }
    setSaving(true);
    try {
      const result = await updateTransactionCashFlowPurpose(transactionId, portions);
      if (!result.success) { toast.error(result.error); return; }
      onSaved(portions);
      toast.success("Cash-flow purpose saved");
      router.refresh();
    } catch { toast.error("Failed to save cash-flow purpose"); }
    finally { setSaving(false); }
  };
  const update = (index: number, next: CashFlowPortion) => setPortions(current => current!.map((p, i) => i === index ? next : p));
  const simple = portions === null ? "automatic" : portions.length === 1 ? key(portions[0]) : "split";
  return <div className="space-y-3">
    <Label htmlFor="cash-flow-purpose">Cash-flow purpose</Label>
    <select id="cash-flow-purpose" value={simple} onChange={e => {
      if (e.target.value === "automatic") setPortions(null);
      else if (e.target.value === "split") setPortions([portion("loan_principal", 0), portion("consumption", 0)]);
      else setPortions([portion(e.target.value, Math.abs(amount))]);
    }} className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm">
      <option value="automatic">Use category default</option>
      {choices.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      <option value="split">Split into portions</option>
    </select>
    {portions?.map((part, index) => <div key={index} className="space-y-2 rounded-md border p-3">
      <Label htmlFor={`portion-purpose-${index}`}>Portion {index + 1} purpose</Label>
      <select id={`portion-purpose-${index}`} value={key(part)} onChange={e => update(index, portion(e.target.value, part.amount))}
        className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm">
        {choices.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <Label htmlFor={`portion-amount-${index}`}>Portion {index + 1} amount ({currency})</Label>
      <Input id={`portion-amount-${index}`} type="number" min="0.01" max={Math.abs(amount)} step="0.01"
        value={part.amount || ""} onChange={e => update(index, { ...part, amount: Number(e.target.value) })} />
      {portions.length > 1 && <Button type="button" variant="ghost" onClick={() => setPortions(portions.filter((_, i) => i !== index))}>Remove portion {index + 1}</Button>}
    </div>)}
    {portions && <Button type="button" variant="outline" disabled={portions.length >= 20}
      onClick={() => setPortions([...portions, portion("consumption", Math.max(0, Math.round((Math.abs(amount) - portions.reduce((s, p) => s + p.amount, 0)) * 100) / 100))])}>Add portion</Button>}
    <p className="text-xs text-muted-foreground">
      Portions must total {Math.abs(amount).toFixed(2)} {currency}. Income, everyday expenses and capital movements are reported separately.
      Investments and loan principal use the same capital rule. Ownership, category and the original payment stay unchanged.
    </p>
    <Button type="button" variant="outline" disabled={saving} onClick={save}>{saving ? "Saving purpose…" : "Save cash-flow purpose"}</Button>
  </div>;
}
