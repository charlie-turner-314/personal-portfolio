export interface AccountRouting {
  sourceAccount?: string | null;
  destinationAccount?: string | null;
  transactionId?: string | null;
  accountMappings?: Record<string, string | null>;
}

export function discoverAccountAliases(headers: string[], rows: string[][], mapping: AccountRouting): string[] {
  const indices = [mapping.sourceAccount, mapping.destinationAccount]
    .filter((column): column is string => Boolean(column))
    .map((column) => {
      const index = headers.indexOf(column);
      if (index < 0) throw new Error(`Account column not found: ${column}`);
      return index;
    });
  return [...new Set(rows.flatMap((row) => indices.map((index) => row[index]?.trim() || "")).filter(Boolean))].sort();
}

export function routeAccountRow(headers: string[], row: string[], mapping: AccountRouting, amount: number) {
  const resolve = (column?: string | null) => {
    if (!column) return null;
    const alias = row[headers.indexOf(column)]?.trim();
    if (!alias) return null;
    if (!Object.hasOwn(mapping.accountMappings ?? {}, alias)) throw new Error(`Confirm the account mapping for ${alias}`);
    return mapping.accountMappings![alias];
  };
  const source = resolve(mapping.sourceAccount);
  const destination = resolve(mapping.destinationAccount);
  if (source && source === destination) throw new Error("Source and destination must map to different accounts");
  if (!source && !destination) return null;
  return {
    accountId: source || destination!,
    destinationAccountId: source && destination ? destination : undefined,
    amount: source ? -Math.abs(amount) : Math.abs(amount),
    transactionType: source ? "debit" as const : "credit" as const,
  };
}
