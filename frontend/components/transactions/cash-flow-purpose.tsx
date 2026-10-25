"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateTransactionCashFlowPurpose } from "@/lib/actions/transactions";
import { validateCashFlowPurpose, type CashFlowKind } from "@/lib/dashboard/cash-flow";

interface Props {
  transactionId: string;
  amount: number;
  currency: string;
  kind?: string | null;
  allocationAmount?: string | null;
  onSaved: (kind: string | null, allocationAmount: string | null) => void;
}

export function CashFlowPurpose({ transactionId, amount, currency, kind, allocationAmount, onSaved }: Props) {
  const router = useRouter();
  const [purpose, setPurpose] = useState(kind ?? "automatic");
  const [allocation, setAllocation] = useState(allocationAmount ?? "");
  const [saving, setSaving] = useState(false);
  const isAllocation = purpose === "investment" || purpose === "loan_principal";
  const save = async () => {
    const value = purpose === "automatic" ? null : purpose as CashFlowKind;
    const portion = isAllocation && allocation !== "" ? Number(allocation) : null;
    const error = validateCashFlowPurpose(value, portion, amount);
    if (error) { toast.error(error); return; }
    setSaving(true);
    try {
      const result = await updateTransactionCashFlowPurpose(transactionId, value, portion);
      if (!result.success) { toast.error(result.error); return; }
      onSaved(value, portion === null ? null : portion.toFixed(2));
      toast.success("Cash-flow purpose saved");
      router.refresh();
    } catch {
      toast.error("Failed to save cash-flow purpose");
    } finally {
      setSaving(false);
    }
  };
  return <div className="space-y-3">
    <Label htmlFor="cash-flow-purpose">Cash-flow purpose</Label>
    <select id="cash-flow-purpose" value={purpose} onChange={e => setPurpose(e.target.value)}
      className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm">
      <option value="automatic">Use category default</option>
      <option value="activity">Everyday income / expense</option>
      <option value="investment">Investment allocation</option>
      <option value="loan_principal">Loan principal</option>
    </select>
    {isAllocation && <div className="space-y-2">
      <Label htmlFor="cash-flow-portion">Allocation portion ({currency})</Label>
      <Input id="cash-flow-portion" type="number" min="0.01" max={Math.abs(amount)} step="0.01"
        placeholder={String(Math.abs(amount))} value={allocation} onChange={e => setAllocation(e.target.value)} />
      <p className="text-xs text-muted-foreground">Leave blank for the full transaction. For a mixed repayment, enter only principal; the remainder stays spending, including interest.</p>
    </div>}
    <p className="text-xs text-muted-foreground">
      Allocations stay in cash flow but are separate from everyday spending and saving from income.
      This setting preserves the amount, category and ownership.
    </p>
    <Button type="button" variant="outline" disabled={saving} onClick={save}>
      {saving ? "Saving purpose…" : "Save cash-flow purpose"}
    </Button>
  </div>;
}
