import { notFound } from "next/navigation";
import {
  listHoldings,
  getHoldingHistory,
  getHoldingLots,
  getHoldingTrades,
  getPortfolio,
  listHoldingIncomeEvents,
  createHoldingIncomeEvent,
  getHoldingCgtAllocations,
} from "@/lib/api/investments";
import { Header } from "@/components/layout/header";
import { HoldingDetailView } from "@/components/investments/HoldingDetailView";
import { rangeToDates } from "@/lib/utils/date-ranges";
import { getAuthenticatedSession } from "@/lib/auth-helpers";
import { isDemoRestrictedUserEmail } from "@/lib/demo-access";

export const dynamic = "force-dynamic";

export default async function HoldingDetailPage({
  params,
}: {
  params: Promise<{ holdingId: string }>;
}) {
  const { holdingId } = await params;
  const { from, to } = rangeToDates("1M");
  // Backend exposes GET /holdings (list) but not GET /holdings/:id,
  // so we fetch holdings + portfolio first, validate the ID, then fetch history.
  // This ensures notFound() is called before getHoldingHistory so an invalid
  // holdingId never reaches the backend history endpoint.
  const [holdings, portfolio] = await Promise.all([listHoldings(), getPortfolio()]);
  const holding = holdings.find((h) => h.id === holdingId);
  if (!holding) return notFound();
  const [history, trades, lots, incomeEvents, cgtAllocations, session] = await Promise.all([
    getHoldingHistory(holdingId, from, to),
    getHoldingTrades(holdingId).catch(() => []),
    getHoldingLots(holdingId).catch(() => []),
    listHoldingIncomeEvents(holdingId).catch(() => []),
    getHoldingCgtAllocations(holdingId).catch(() => []),
    getAuthenticatedSession(),
  ]);
  const isDemoRestricted = isDemoRestrictedUserEmail(session?.user?.email);
  return (
    <>
      <Header title={holding.symbol} />
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <HoldingDetailView
          holding={holding}
          portfolio={portfolio}
          initialHistory={history}
          trades={trades}
          lots={lots}
          incomeEvents={incomeEvents}
          realisedCgtDisposals={toRealisedCgtDisposals(cgtAllocations)}
          onCreateIncomeEvent={createHoldingIncomeEvent.bind(null, holding.account_id, holding.id)}
          isDemoRestricted={isDemoRestricted}
        />
      </div>
    </>
  );
}

function toRealisedCgtDisposals(allocations: Awaited<ReturnType<typeof getHoldingCgtAllocations>>) {
  const byDisposal = new Map<string, typeof allocations>();
  for (const allocation of allocations) {
    const current = byDisposal.get(allocation.disposal_trade_id) ?? [];
    current.push(allocation);
    byDisposal.set(allocation.disposal_trade_id, current);
  }
  return [...byDisposal.entries()].map(([id, rows]) => {
    const hasMissingFx = rows.some((row) => row.fx_missing);
    const currency = hasMissingFx ? rows[0].currency : "AUD";
    const costBase = rows.reduce((total, row) => total + Number(hasMissingFx ? row.cost_base_native : row.cost_base_aud), 0);
    const proceeds = rows.reduce((total, row) => total + Number(hasMissingFx ? row.proceeds_native : row.proceeds_aud), 0);
    const gain = rows.reduce((total, row) => total + Number(hasMissingFx ? row.gain_native : row.gain_aud), 0);
    return {
      id,
      disposal_date: rows[0].disposal_date,
      quantity: rows.reduce((total, row) => total + Number(row.quantity), 0).toString(),
      cost_base: costBase.toFixed(2),
      proceeds: proceeds.toFixed(2),
      capital_gain: gain.toFixed(2),
      currency,
      calculation_status: hasMissingFx ? "partial" as const : "complete" as const,
      allocations: rows.map((row) => ({
        id: row.id,
        acquisition_date: row.acquisition_date,
        quantity: row.quantity,
        cost_base: (hasMissingFx ? row.cost_base_native : row.cost_base_aud)?.toString() ?? null,
        proceeds: (hasMissingFx ? row.proceeds_native : row.proceeds_aud)?.toString() ?? null,
        capital_gain: (hasMissingFx ? row.gain_native : row.gain_aud)?.toString() ?? null,
        currency,
        discount_eligible: row.discount_eligible,
      })),
      assumptions: rows[0].assumptions,
      unavailable_reason: hasMissingFx ? "Transaction-date AUD FX is missing; native-currency amounts are shown." : null,
    };
  });
}
