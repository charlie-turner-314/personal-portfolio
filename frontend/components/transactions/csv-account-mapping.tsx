"use client";

import { useEffect, useState } from "react";
import { getAccounts } from "@/lib/actions/accounts";
import { discoverAccountAliases } from "@/lib/import/account-routing";
import type { ColumnMapping, ParsedCsvData } from "@/lib/actions/csv-import";

export function CsvAccountMapping({ data, mapping, onChange }: {
  data: ParsedCsvData; mapping: ColumnMapping; onChange: (mapping: ColumnMapping) => void;
}) {
  const [availableAccounts, setAvailableAccounts] = useState<Array<{ id: string; name: string; currency: string | null }>>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    getAccounts().then((accounts) => { if (active) setAvailableAccounts(accounts); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, []);
  if (error && (mapping.sourceAccount || mapping.destinationAccount)) return <p role="alert">Could not load accounts. Reload this page to confirm account mappings.</p>;
  if (!mapping.sourceAccount && !mapping.destinationAccount) return null;
  return (
  <section className="mb-6 space-y-3 rounded-lg border p-4">
    <h3 className="font-medium">Confirm accounts</h3>
    <p className="text-sm text-muted-foreground">Choose an account for every bank name, or explicitly leave it external. Two owned accounts create a linked internal transfer. Rows with neither side mapped are skipped.</p>
    {!mapping.transactionId && <p className="text-sm text-muted-foreground">Without a transaction ID, identical date, amount, description and account combinations are treated as duplicates. Map a unique reference column to distinguish repeated payments.</p>}
    {discoverAccountAliases(data.headers, data.rows, mapping).map((alias) => (
      <label key={alias} className="block space-y-1 text-sm">
        <span>{alias}</span>
        <select aria-label={`Account for ${alias}`} className="block w-full rounded-md border bg-background p-2"
          value={Object.hasOwn(mapping.accountMappings ?? {}, alias) ? mapping.accountMappings![alias] ?? "external" : ""}
          onChange={(event) => onChange({ ...mapping, accountMappings: { ...mapping.accountMappings, [alias]: event.target.value === "external" ? null : event.target.value } })}>
          <option value="" disabled>Choose an account</option>
          <option value="external">External / leave unmapped</option>
          {availableAccounts.map((account) => <option key={account.id} value={account.id}>{account.name} ({account.currency})</option>)}
        </select>
      </label>
    ))}
  </section>
  );
}
