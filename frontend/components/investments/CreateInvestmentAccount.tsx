"use client";

import { useState } from "react";
import { createManualAccount, type InvestmentAccount } from "@/lib/api/investments";
import { INVESTMENT_CURRENCIES } from "@/lib/utils/currency";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function CreateInvestmentAccount({ defaultCurrency = "AUD", onCreated }: {
  defaultCurrency?: string;
  onCreated: (account: InvestmentAccount) => void;
}) {
  const [creationKey, setCreationKey] = useState(() => crypto.randomUUID());
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <form className="space-y-3 rounded-md border p-4" onSubmit={async (event) => {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      const result = await createManualAccount(name.trim(), currency, creationKey);
      onCreated({ id: result.account_id, name: name.trim(), base_currency: currency, source: "manual", can_add_holdings: true });
      setName("");
      setCreationKey(crypto.randomUUID());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Account creation failed");
    } finally { setBusy(false); }
  }}>
    <p className="text-sm font-medium">Create an investment account</p>
    <Label htmlFor="investment-account-name">Account name</Label>
    <Input id="investment-account-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={255} />
    <Label htmlFor="investment-account-currency">Account currency</Label>
    <select id="investment-account-currency" className="block rounded border bg-background p-2" value={currency} onChange={(e) => setCurrency(e.target.value)}>
      {Array.from(new Set([...INVESTMENT_CURRENCIES, currency])).map((ccy) => <option key={ccy}>{ccy}</option>)}
    </select>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button disabled={busy || !name.trim()} type="submit">{busy ? "Creating…" : "Create empty account"}</Button>
  </form>;
}
