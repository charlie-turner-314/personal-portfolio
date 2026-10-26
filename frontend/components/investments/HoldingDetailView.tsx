"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RiArrowLeftLine, RiEditLine } from "@remixicon/react";
import {
  fetchHoldingHistoryRange,
  type Range,
} from "@/lib/actions/investments";
import {
  type Holding,
  type HoldingLot,
  type HoldingTrade,
  type PortfolioSummary,
  type ValuationPoint,
} from "@/lib/api/investments";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import { currencySymbol } from "@/lib/utils/currency";
import { ManualPriceForm } from "./ManualPriceForm";
import { PortfolioChart } from "./PortfolioChart";
import { TypeBadge } from "./HoldingsTableHF";
import { EditHoldingDialog } from "./EditHoldingDialog";
import { InvestmentIncomePanel } from "./InvestmentIncomePanel";
import { RealisedCgtDisposals } from "./RealisedCgtDisposals";
import type { RealisedCgtDisposal } from "./cgt-types";
import type {
  CreateInvestmentIncomeEvent,
  InvestmentIncomeEvent,
  InvestmentIncomeTotals,
} from "./income-types";

const RANGES: Range[] = ["1W", "1M", "3M", "1Y", "FY", "ALL"];

function fmt(n: number, digits = 2) {
  return n.toLocaleString("en", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function HoldingDetailView({
  holding,
  portfolio,
  initialHistory,
  trades = [],
  lots = [],
  incomeEvents = [],
  incomeTotals,
  onCreateIncomeEvent,
  realisedCgtDisposals = [],
  isDemoRestricted = false,
  dataErrors = [],
  personScope,
}: {
  holding: Holding;
  portfolio: PortfolioSummary;
  initialHistory: ValuationPoint[];
  trades?: HoldingTrade[];
  lots?: HoldingLot[];
  incomeEvents?: InvestmentIncomeEvent[];
  incomeTotals?: InvestmentIncomeTotals;
  onCreateIncomeEvent?: (event: Omit<CreateInvestmentIncomeEvent, "account_id" | "holding_id">) => Promise<unknown>;
  realisedCgtDisposals?: RealisedCgtDisposal[];
  isDemoRestricted?: boolean;
  dataErrors?: string[];
  personScope?: string;
}) {
  const router = useRouter();
  const [range, setRange] = useState<Range>("1M");
  const [history, setHistory] = useState<ValuationPoint[]>(initialHistory);
  const [pending, startTransition] = useTransition();
  const [editOpen, setEditOpen] = useState(false);
  const [chartErr, setChartErr] = useState<string | null>(null);
  const activeRangeRef = useRef<Range>("1M");

  const series = history
    .map((p) => Number(p.value))
    .filter((v) => Number.isFinite(v));

  const portfolioCurrSym = currencySymbol(portfolio.currency);
  const holdingCurrSym = currencySymbol(holding.currency);
  const quoteCurrSym = currencySymbol(holding.quote_currency ?? holding.currency);
  const marketValue = Number(holding.current_value_user_currency ?? 0);
  const totalValue = Number(portfolio.total_value);
  const weight = totalValue > 0 ? (marketValue / totalValue) * 100 : 0;
  const costBasis =
    holding.cost_basis_user_currency != null
      ? Number(holding.cost_basis_user_currency)
      : null;
  const totalReturn =
    costBasis != null && costBasis > 0 && holding.current_value_user_currency != null && !holding.valuation_error
      ? ((marketValue - costBasis) / costBasis) * 100
      : null;

  const accountName =
    portfolio.accounts.find((a) => a.id === holding.account_id)?.name ??
    holding.account_id;

  const onRangeChange = (r: Range) => {
    const prev = range;
    setRange(r);
    setChartErr(null);
    activeRangeRef.current = r;
    startTransition(async () => {
      try {
        const next = await fetchHoldingHistoryRange(holding.id, r, personScope);
        if (activeRangeRef.current === r) setHistory(next);
      } catch {
        if (activeRangeRef.current === r) {
          activeRangeRef.current = prev;
          setRange(prev);
          setChartErr("Could not load history.");
        }
      }
    });
  };

  const stats: { label: string; value: string; tone?: "positive" | "negative" }[] = [
    {
      label: "Current price",
      value: holding.current_price
        ? `${quoteCurrSym} ${fmt(Number(holding.current_price))}`
        : "—",
    },
    {
      label: holding.archived_at ? "Last recorded value" : "Market value",
      value: holding.current_value_user_currency == null ? "Unavailable" : `${portfolioCurrSym} ${fmt(marketValue)}`,
    },
    {
      label: "Unrealised return on recorded cost",
      value:
        totalReturn != null
          ? `${totalReturn >= 0 ? "+" : ""}${fmt(totalReturn)}%`
          : "—",
      tone:
        totalReturn == null
          ? undefined
          : totalReturn >= 0
            ? "positive"
            : "negative",
    },
    {
      label: "Avg cost / share",
      value: holding.avg_cost
        ? `${holdingCurrSym} ${fmt(Number(holding.avg_cost))}`
        : "—",
    },
    {
      label: "Portfolio weight",
      value: holding.current_value_user_currency == null || holding.archived_at ? "Unavailable" : `${fmt(weight, 1)}%`,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {dataErrors.length > 0 && <div role="alert" className="rounded border border-destructive p-3 text-sm">{dataErrors.join(" ")}</div>}
      {holding.ownership_share != null && Number(holding.ownership_share) !== 1 && <p className="text-sm text-muted-foreground">Value and chart reflect the selected ownership share ({Number(holding.ownership_share) * 100}%). Units and source transaction records describe the whole account position.</p>}
      {holding.archived_at && <p role="status" className="text-sm">Archived position. Financial records are preserved.</p>}
      {holding.valuation_error && <p role="status" className="text-sm text-amber-700">{holding.valuation_error}. Any displayed valuation is the last known value.</p>}
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => router.push(`/investments${personScope ? `?personIds=${encodeURIComponent(personScope)}` : ""}`)}
      >
        <RiArrowLeftLine className="size-4" />
        All holdings
      </Button>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <span className="text-2xl font-bold tracking-tight">{holding.symbol}</span>
          <TypeBadge type={holding.instrument_type} />
          {holding.name && (
            <span className="text-sm text-muted-foreground">{holding.name}</span>
          )}
          {holding.is_stale && (
            <span
              title="Price may be stale"
              className="size-2 rounded-full bg-amber-500"
            />
          )}
          <Badge variant="outline" className="ml-auto">
            {accountName}
          </Badge>
          {!isDemoRestricted && (holding.can_edit ?? holding.source === "manual") && (
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
              <RiEditLine className="size-4" />
              Edit
            </Button>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {stats.map(({ label, value, tone }) => (
          <Card key={label}>
            <CardContent className="flex flex-col gap-1 p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {label}
              </div>
              <div
                className={`text-sm font-semibold tabular-nums ${
                  tone === "positive"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : tone === "negative"
                      ? "text-destructive"
                      : ""
                }`}
              >
                {value}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className={pending ? "opacity-70 transition-opacity" : "transition-opacity"}>
        <CardHeader className="flex flex-row items-center justify-end pb-0">
          <ToggleGroup
            multiple={false}
            value={[range]}
            onValueChange={(v) => v[0] && onRangeChange(v[0] as Range)}
            variant="outline"
            size="sm"
          >
            {RANGES.map((r) => (
              <ToggleGroupItem key={r} value={r} aria-label={`Range ${r}`}>
                {r}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </CardHeader>
        <CardContent>
          {chartErr && (
            <p className="text-xs text-destructive mb-2">{chartErr}</p>
          )}
          <PortfolioChart dates={history.map((point) => point.date)} data={series} currencySymbol={portfolioCurrSym} />
        </CardContent>
      </Card>

      <Tabs defaultValue="overview">
        <TabsList className="max-sm:grid max-sm:h-auto max-sm:w-full max-sm:grid-cols-2 max-sm:gap-2 max-sm:[&>button]:h-11">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="transactions">Transactions</TabsTrigger>
          <TabsTrigger value="income">Income</TabsTrigger>
          <TabsTrigger value="capital-gains">Capital gains</TabsTrigger>
          <TabsTrigger value="about">About</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Card>
            <CardContent className="p-4">
              {lots.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No open lots. {holding.source === "trade_import"
                    ? "All shares for this position have been sold."
                    : "Position metadata, cost-basis breakdown and lots will appear here once trades are imported."}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                        <th className="py-2 pr-4">Open date</th>
                        <th className="py-2 pr-4 text-right">Quantity</th>
                        <th className="py-2 pr-4 text-right">
                          Cost / share ({holding.currency})
                        </th>
                        <th className="py-2 pr-4 text-right">
                          Lot value ({holdingCurrSym})
                        </th>
                        <th className="py-2 pr-4 text-right">Age</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lots.map((lot, idx) => {
                        const qty = Number(lot.quantity_remaining);
                        const cps = Number(lot.cost_per_share_native);
                        const px = Number(holding.current_price ?? 0);
                        const lotValue = px > 0 ? qty * px : NaN;
                        return (
                          <tr
                            key={`${lot.open_date}-${lot.cost_per_share_native}-${idx}`}
                            className="border-b last:border-b-0"
                          >
                            <td className="py-2 pr-4 tabular-nums">
                              {lot.open_date}
                            </td>
                            <td className="py-2 pr-4 text-right tabular-nums">
                              {fmt(qty, qty < 1 ? 4 : 2)}
                            </td>
                            <td className="py-2 pr-4 text-right tabular-nums">
                              {fmt(cps, 4)}
                            </td>
                            <td className="py-2 pr-4 text-right tabular-nums">
                              {Number.isFinite(lotValue)
                                ? `${holdingCurrSym} ${fmt(lotValue)}`
                                : "—"}
                            </td>
                            <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">
                              {lot.age_days}d
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="transactions">
          <Card>
            <CardContent className="p-4">
              {trades.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No trades recorded for this holding yet.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                        <th className="py-2 pr-4">Date</th>
                        <th className="py-2 pr-4">Side</th>
                        <th className="py-2 pr-4 text-right">Qty</th>
                        <th className="py-2 pr-4 text-right">
                          Price ({holding.currency})
                        </th>
                        <th className="py-2 pr-4 text-right">Fees</th>
                        <th className="py-2 pr-4 text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trades.map((t) => {
                        const total =
                          t.side === "buy"
                            ? Number(t.cost_native ?? 0)
                            : Number(t.proceeds_native ?? 0);
                        return (
                          <tr key={t.id} className="border-b last:border-b-0">
                            <td className="py-2 pr-4 tabular-nums">
                              {t.trade_date}
                            </td>
                            <td className="py-2 pr-4 capitalize">
                              <span
                                className={
                                  t.side === "buy"
                                    ? "text-emerald-600 dark:text-emerald-400"
                                    : "text-destructive"
                                }
                              >
                                {t.side}
                              </span>
                            </td>
                            <td className="py-2 pr-4 text-right tabular-nums">
                              {fmt(Number(t.quantity), 4)}
                            </td>
                            <td className="py-2 pr-4 text-right tabular-nums">
                              {fmt(Number(t.price), 4)}
                            </td>
                            <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">
                              {Number(t.fees) > 0 ? fmt(Number(t.fees), 2) : "—"}
                            </td>
                            <td className="py-2 pr-4 text-right tabular-nums">
                              {holdingCurrSym} {fmt(total)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="income">
          <InvestmentIncomePanel
            events={incomeEvents}
            totals={incomeTotals}
            defaultCurrency={holding.currency}
            onCreate={isDemoRestricted ? undefined : onCreateIncomeEvent}
          />
        </TabsContent>
        <TabsContent value="capital-gains">
          <RealisedCgtDisposals disposals={realisedCgtDisposals} />
        </TabsContent>
        <TabsContent value="about">
          {!isDemoRestricted && (holding.can_manage ?? holding.source === "manual") && holding.instrument_type !== "cash" && !holding.archived_at && <ManualPriceForm holding={holding} />}
          <Card>
            <CardContent className="p-4 text-sm">
              <dl className="grid grid-cols-2 gap-y-2 gap-x-6">
                <dt className="text-muted-foreground">Symbol</dt>
                <dd>{holding.symbol}</dd>
                <dt className="text-muted-foreground">Price date</dt><dd>{holding.quote_date ?? "Unavailable"}</dd>
                <dt className="text-muted-foreground">Price source</dt><dd>{holding.quote_source ?? "Unverified"}</dd>
                <dt className="text-muted-foreground">Cost basis source</dt><dd>{holding.cost_basis_kind === "recorded_lots" ? "Recorded lots with dated FX" : holding.cost_basis_kind === "manual_opening_estimate" ? "Manual opening estimate" : "Unavailable / incomplete"}</dd>
                <dt className="text-muted-foreground">Instrument type</dt>
                <dd className="capitalize">{holding.instrument_type}</dd>
                <dt className="text-muted-foreground">Currency</dt>
                <dd>{holding.currency}</dd>
                <dt className="text-muted-foreground">Source</dt>
                <dd className="capitalize">{holding.source}</dd>
                <dt className="text-muted-foreground">Account</dt>
                <dd>{accountName}</dd>
              </dl>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {!isDemoRestricted && (holding.can_edit ?? holding.source === "manual") && (
        <EditHoldingDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          holding={holding}
        />
      )}
    </div>
  );
}
