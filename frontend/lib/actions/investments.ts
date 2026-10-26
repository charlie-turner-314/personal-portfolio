"use server";

import { rangeToDates, type Range } from "@/lib/utils/date-ranges";

// Re-export for consumers that import Range from this module
export type { Range } from "@/lib/utils/date-ranges";

export async function fetchHistoryRange(range: Range, personIds?: string) {
  const { getPortfolioHistory } = await import("@/lib/api/investments");
  const { from, to } = rangeToDates(range);
  return getPortfolioHistory(from, to, personIds);
}

export async function searchSymbolsAction(q: string) {
  if (!q.trim()) return [];
  const { searchSymbols } = await import("@/lib/api/investments");
  return searchSymbols(q);
}

export async function fetchHoldingHistoryRange(holdingId: string, range: Range, personIds?: string) {
  const { getHoldingHistory } = await import("@/lib/api/investments");
  const { from, to } = rangeToDates(range);
  return getHoldingHistory(holdingId, from, to, personIds);
}

export async function syncAllInvestmentsAction(): Promise<{ count: number; account_ids?: string[] }> {
  const { syncAllInvestments } = await import("@/lib/api/investments");
  return syncAllInvestments();
}

export async function resolveInvestmentSymbolAction(symbol: string) {
  const { resolveInvestmentSymbol } = await import("@/lib/api/investments");
  return resolveInvestmentSymbol(symbol);
}
