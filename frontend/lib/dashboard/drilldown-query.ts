import {
  parseHorizonParam,
  parseIsoDateParam,
  type SupportedHorizon,
} from "@/lib/dashboard/query-params";

interface DrilldownQueryOptions {
  personId?:string;
  categoryId?: string | null;
  accountIds?: string[];
  dateFrom?: string;
  dateTo?: string;
  horizon?: number;
}

export function buildTransactionsDrilldownQuery({
  personId,
  categoryId,
  accountIds,
  dateFrom,
  dateTo,
  horizon,
}: DrilldownQueryOptions): string {
  const params = new URLSearchParams();
  if(personId)params.set("person",personId);

  if (categoryId) {
    params.set("category", categoryId);
  }

  if (accountIds?.length) {
    Array.from(new Set(accountIds.map((value) => value.trim()).filter(Boolean))).forEach(
      (accountId) => params.append("account", accountId)
    );
  }

  const normalizedFrom = parseIsoDateParam(dateFrom);
  const normalizedTo = parseIsoDateParam(dateTo);

  if (normalizedFrom) {
    params.set("from", normalizedFrom);
    if (normalizedTo && normalizedTo >= normalizedFrom) {
      params.set("to", normalizedTo);
    }
  } else {
    const normalizedHorizon =
      parseHorizonParam(typeof horizon === "number" ? String(horizon) : undefined) ??
      (30 as SupportedHorizon);
    params.set("horizon", String(normalizedHorizon));
  }

  return params.toString();
}
