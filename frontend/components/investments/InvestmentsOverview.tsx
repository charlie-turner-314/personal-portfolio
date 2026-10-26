"use client";
import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RiRefreshLine } from "@remixicon/react";
import {
  fetchHistoryRange,
  syncAllInvestmentsAction,
  type Range,
} from "@/lib/actions/investments";
import {
  archiveHolding,
  getInvestmentSyncStatus,
  type BrokerConnection,
  type Holding,
  type PortfolioSummary,
  type ValuationPoint,
} from "@/lib/api/investments";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { currencySymbol } from "@/lib/utils/currency";
import { PortfolioHero } from "./PortfolioHero";
import { PortfolioChart } from "./PortfolioChart";
import { PortfolioStatsStrip } from "./PortfolioStatsStrip";
import { AllocationRow } from "./AllocationRow";
import { HoldingsTableHF } from "./HoldingsTableHF";
import { PortfolioIncomeSummary } from "./PortfolioIncomeSummary";
import { PortfolioCgtSummary } from "./PortfolioCgtSummary";
import { BrokerConnectionsPanel } from "./BrokerConnectionsPanel";
import type { CgtFinancialYearSummary } from "./cgt-types";
import type { PortfolioIncomeSummary as IncomeSummary } from "./income-types";

export function InvestmentsOverview({
  portfolio,
  holdings,
  initialHistory,
  initialRange = "1M",
  incomeSummaries = [],
  cgtSummaries = [],
  connections = [],
  isDemoRestricted = false,
  personScope,
  financialYears = [],
  selectedFinancialYear,
  reportErrors = {},
}: {
  portfolio: PortfolioSummary;
  holdings: Holding[];
  initialHistory: ValuationPoint[];
  initialRange?: Range;
  incomeSummaries?: IncomeSummary[];
  cgtSummaries?: CgtFinancialYearSummary[];
  connections?: BrokerConnection[];
  isDemoRestricted?: boolean;
  personScope?: string;
  financialYears?: number[];
  selectedFinancialYear?: number;
  reportErrors?: { income?: string; cgt?: string; history?: string };
}) {
  const router = useRouter();
  const onFinancialYearChange = (year: number) => {
    const url = new URL(window.location.href);
    url.searchParams.set("financialYearStart", String(year));
    router.push(`${url.pathname}${url.search}`);
  };
  const [range, setRange] = useState<Range>(initialRange);
  const [history, setHistory] = useState<ValuationPoint[]>(initialHistory);
  const [pending, startTransition] = useTransition();
  const activeRangeRef = useRef<Range>(initialRange);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const series = useMemo(
    () => history.map((p) => Number(p.value)).filter((v) => Number.isFinite(v)),
    [history],
  );
  const first = series[0] ?? 0;
  const last = series[series.length - 1] ?? 0;
  const absChange = last - first;
  const pctChange = first > 0 ? (absChange / first) * 100 : 0;
  const totalValue = portfolio.valuation_status === "unavailable" ? null : Number(portfolio.total_value);

  // Real cost basis & unrealized P&L from per-holding cost_basis_user_currency
  // (server-side dated lots or an explicitly identified manual opening estimate).
  //
  // "Active position" = one we still hold (quantity != 0). This INCLUDES
  // holdings that are currently worth zero (e.g. delisted/worthless stock
  // we haven't sold) — those are real unrealized losses and must be
  // counted. EXCLUDES fully-sold positions (qty=0, avg_cost=null), whose
  // P&L is already realized.
  //
  // Incomplete cost basis remains unavailable; chart movement is not profit.
  let activePositions = 0;
  let activeWithCost = 0;
  let costBasisFromHoldings = 0;
  let valueFromHoldings = 0;
  for (const h of holdings) {
    if (h.archived_at) continue;
    const qty = Number(h.quantity ?? 0);
    if (!Number.isFinite(qty) || qty === 0) continue;
    activePositions += 1;
    const v = Number(h.current_value_user_currency ?? 0);
    if (Number.isFinite(v)) valueFromHoldings += v;
    const c = h.cost_basis_user_currency;
    if (c != null) {
      const cn = Number(c);
      if (Number.isFinite(cn)) {
        costBasisFromHoldings += cn;
        activeWithCost += 1;
      }
    }
  }
  const isEmptyPortfolio = activePositions === 0;
  const hasCompleteCost = !isEmptyPortfolio && activeWithCost === activePositions;
  const costBasis = isEmptyPortfolio ? 0 : hasCompleteCost ? costBasisFromHoldings : null;
  const unrealizedPnl = isEmptyPortfolio ? 0 : hasCompleteCost && holdings.filter((h) => !h.archived_at).every((h) => h.current_value_user_currency != null && !h.valuation_error) ? valueFromHoldings - costBasisFromHoldings : null;
  const accountNames = Object.fromEntries(
    portfolio.accounts.map((a) => [a.id, a.name]),
  );
  const staleCount = holdings.filter((h) => !h.archived_at && h.is_stale).length;
  const onRangeChange = (r: Range) => {
    setRange(r);
    activeRangeRef.current = r;
    startTransition(async () => {
      try {
        const next = await fetchHistoryRange(r, personScope);
        if (activeRangeRef.current === r) setHistory(next);
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : "Could not load portfolio history");
      }
    });
  };

  const onArchive = async (id: string) => {
    try {
      await archiveHolding(id);
      toast.success("Holding archived; financial history preserved");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const onSync = async () => {
    setSyncing(true);
    try {
      const queued = await syncAllInvestmentsAction();
      if (queued.count === 0) { setSyncMessage("No accounts you own are available to refresh."); return; }
      setSyncMessage(`Refreshing ${queued.count} account(s)…`);
      for (let attempt = 0; attempt < 60; attempt++) {
        const states = await getInvestmentSyncStatus();
        const selected = queued.account_ids ? states.filter((state) => queued.account_ids!.includes(state.account_id)) : states;
        if (selected.length >= queued.count && selected.every((state) => !["queued", "running", "idle"].includes(state.status))) {
          const problems = selected.filter((state) => state.status !== "completed");
          setSyncMessage(problems.length ? `${problems.length} account(s) need review. ${problems.map((state) => `${state.name}: ${state.error ?? state.status}`).join("; ")}` : "Portfolio refresh completed.");
          router.refresh();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      setSyncMessage("Refresh is taking longer than expected. It may still be running; check account status or retry later.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const sym = currencySymbol(portfolio.currency);

  const refreshButton = isDemoRestricted ? null : (
    <Button
      variant="outline"
      size="sm"
      onClick={onSync}
      disabled={syncing}
      title="Refresh portfolio"
    >
      <RiRefreshLine className={syncing ? "size-3 animate-spin" : "size-3"} />
      {syncing ? "Syncing…" : "Refresh portfolio"}
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      <PortfolioHero
        totalValue={totalValue}
        currency={portfolio.currency}
        absChange={absChange}
        pctChange={pctChange}
        range={range}
        onRangeChange={onRangeChange}
        asOf={portfolio.as_of ?? null}
        staleCount={staleCount}
        headerAction={refreshButton}
      />

      {portfolio.valuation_status && portfolio.valuation_status !== "complete" && <p role="status" className="rounded border border-amber-600/30 p-3 text-sm">Portfolio valuation is partial. {portfolio.unavailable_holdings} holding(s) have missing or stale prices/FX. Where available, last known values are retained.</p>}
      <p className="text-xs text-muted-foreground">Cost basis uses recorded lots where available; manual averages are opening estimates. Chart changes include contributions and withdrawals; they are changes in portfolio value, not investment returns.</p>
      {portfolio.accounts.some((account) => account.sync_state) && <div className="space-y-1 text-xs text-muted-foreground" aria-label="Account refresh status">
        {portfolio.accounts.filter((account) => account.sync_state).map((account) => <p key={account.id}>{account.name}: {account.sync_state!.status}{account.sync_state!.completed_at ? ` · ${account.sync_state!.completed_at}` : ""}{account.sync_state!.error ? ` · ${account.sync_state!.error}` : ""}</p>)}
      </div>}
      {syncMessage && <p role="status" className="text-sm">{syncMessage}</p>}
      <BrokerConnectionsPanel connections={connections} readOnly={isDemoRestricted} />

      {reportErrors.history && <p role="alert" className="text-sm text-destructive">{reportErrors.history}</p>}
      <Card className={pending ? "opacity-70 transition-opacity" : "transition-opacity"}>
        <CardContent className="p-4">
          <PortfolioChart dates={history.map((point) => point.date)} data={series} currencySymbol={sym} />
          <PortfolioStatsStrip
            costBasis={costBasis}
            unrealizedPnl={unrealizedPnl}
            returnPct={null}
            holdingsCount={holdings.filter((h) => !h.archived_at).length}
            accountsCount={portfolio.accounts.length}
            bestDay={null}
            currencySymbol={sym}
          />
        </CardContent>
      </Card>

      <AllocationRow
        byInstrument={portfolio.allocation_by_type}
        byCurrency={portfolio.allocation_by_currency}
      />
      <PortfolioIncomeSummary summaries={incomeSummaries} availableYears={financialYears} selectedYear={selectedFinancialYear} onYearChange={onFinancialYearChange} error={reportErrors.income} />
      <PortfolioCgtSummary summaries={cgtSummaries} availableYears={financialYears} selectedYear={selectedFinancialYear} onYearChange={onFinancialYearChange} error={reportErrors.cgt} />
      {holdings.some((holding) => holding.archived_at) && <details className="border p-3 text-sm"><summary>Archived holdings ({holdings.filter((holding) => holding.archived_at).length})</summary><ul className="mt-2 space-y-1">{holdings.filter((holding) => holding.archived_at).map((holding) => <li key={holding.id}><a className="underline" href={`/investments/${holding.id}?personIds=${encodeURIComponent(personScope ?? "self")}`}>{holding.symbol} · records and history</a></li>)}</ul></details>}
      <HoldingsTableHF
        personScope={personScope}
        holdings={holdings.filter((holding) => !holding.archived_at)}
        accountNames={accountNames}
        accountsCount={portfolio.accounts.length}
        portfolioCurrencySymbol={sym}
        onAddClick={
          isDemoRestricted
            ? undefined
            : () => router.push("/investments/connect")
        }
        onArchive={isDemoRestricted ? undefined : onArchive}
        readOnly={isDemoRestricted}
      />
    </div>
  );
}
