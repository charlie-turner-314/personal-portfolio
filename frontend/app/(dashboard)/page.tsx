import { cache, Suspense } from "react";
import { formatCurrency } from "@/lib/utils";
import { Header } from "@/components/layout/header";
import { KpiSparkCard } from "@/components/charts/kpi-spark-card";
import { ProfitLossChart } from "@/components/charts/profit-loss-chart";
import { SpendingByCategoryChart } from "@/components/charts/spending-by-category-chart";
import { SankeyFlowChart } from "@/components/charts/sankey-flow-chart";
import { NetWorthTotals } from "@/components/household/net-worth-totals";
import { AssetsOverviewCard } from "@/components/assets";
import { PortfolioSummaryCard } from "@/components/investments/PortfolioSummaryCard";
import { CashFlowSummary } from "@/components/dashboard/cash-flow-summary";
import { DashboardFilters } from "@/components/dashboard/dashboard-filters";
import { SearchButton } from "@/components/dashboard/search-button";
import { UpcomingPlannedExpensesCard } from "@/components/dashboard/upcoming-planned-expenses-card";
import {
  getAssetsOverview,
  getDashboardData,
  getUserAccounts,
  type DashboardFilters as DashboardFiltersType,
} from "@/lib/actions/dashboard";
import { parseDashboardSearchParams } from "@/lib/dashboard/query-params";
import { Skeleton } from "@/components/ui/skeleton";
import { DashboardSkeleton } from "@/components/dashboard/dashboard-skeleton";

// React.cache deduplicates these two consumers within one render only. Financial
// permissions are still evaluated live on every new navigation/request.
const getDashboardAssets = cache(getAssetsOverview);

function CardLoading({ label, height = "h-48" }: { label: string; height?: string }) {
  return <div role="status" aria-label={label} className="min-w-0">
    <span className="sr-only">{label}…</span><Skeleton className={`${height} w-full`} />
  </div>;
}

async function LiabilitiesKpi({ accountIds, personId }: { accountIds?: string[]; personId?: string }) {
  const data = await getDashboardAssets(accountIds, personId);
  return <KpiSparkCard
    title="Total Liabilities"
    value={-Math.abs(data.totalLiabilities)}
    currency={data.currency}
    subtitle="Balance owed · included in net worth"
    sparkData={[]}
    valueTone="liability"
    showSign
  />;
}

async function AssetsOverviewSection({ accountIds, personId }: { accountIds?: string[]; personId?: string }) {
  return <AssetsOverviewCard data={await getDashboardAssets(accountIds, personId)} />;
}

interface PageProps {
  searchParams: Promise<{
    [key: string]: string | string[] | undefined;
  }>;
}

export default async function HomePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const parsedParams = parseDashboardSearchParams(params);

  return (
    <>
      <Header title="Dashboard" />
      {/* The heavy data fetch lives inside this boundary, so the shell paints
          immediately and the charts stream in once their queries resolve,
          rather than blocking the whole navigation. */}
      <Suspense fallback={<DashboardSkeleton />}>
        <DashboardContent parsedParams={parsedParams} />
      </Suspense>
    </>
  );
}

async function DashboardContent({
  parsedParams,
}: {
  parsedParams: ReturnType<typeof parseDashboardSearchParams>;
}) {
  const accountIds = parsedParams.accountIds;
  const personId = parsedParams.personId;
  const dateFromParam = parsedParams.dateFrom;
  const dateToParam = parsedParams.dateTo;
  const horizonValue = parsedParams.horizon;
  const effectiveHorizon = parsedParams.effectiveHorizon;

  // Parse filters from URL search params
  const filters: DashboardFiltersType = {};

  if (accountIds?.length) {
    filters.accountIds = accountIds;
  }
  if (personId) {
    filters.personId = personId;
  }

  if (dateFromParam) {
    filters.dateFrom = new Date(dateFromParam);
  }

  if (dateToParam) {
    filters.dateTo = new Date(dateToParam);
  }

  filters.horizon = horizonValue;

  // Fetch data in parallel
  const [data, accounts] = await Promise.all([
    getDashboardData(filters),
    getUserAccounts(),
  ]);

  const accountSubtitle = !accountIds?.length
    ? "Bank and cash accounts · net of overdrafts"
    : accountIds.length === 1
      ? "Selected bank/cash account"
      : "Selected bank/cash accounts";

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
      {/* Filters Row */}
        <div className="flex flex-wrap items-center justify-between gap-2" data-walkthrough="walkthrough-filters">
          <Suspense fallback={null}>
            <DashboardFilters accounts={accounts} />
          </Suspense>
          <SearchButton />
        </div>
        {data.activityMissingConversions > 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            Income and spending totals exclude {data.activityMissingConversions} transaction(s) or linked groups
            awaiting currency conversion.
          </p>
        )}
        {/* Row 1: KPI Cards */}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <div data-walkthrough="walkthrough-balance">
            <KpiSparkCard
              title="Total Cash"
            value={data.balance.total}
            currency={data.balance.currency}
            subtitle={accountSubtitle}
            sparkData={data.balanceHistory}
            showSign
          />
          </div>
          <Suspense fallback={<CardLoading label="Loading liabilities" height="h-32" />}>
            <LiabilitiesKpi accountIds={accountIds} personId={personId} />
          </Suspense>
          <div data-walkthrough="walkthrough-spending">
          <KpiSparkCard
            title={`${data.periodLabel.title} Spending`}
            value={data.periodSpending.total}
            currency={data.periodSpending.currency}
            subtitle={data.periodLabel.subtitle}
            sparkData={data.spendingHistory}
          />
          </div>
          <div data-walkthrough="walkthrough-income">
          <KpiSparkCard
            title={`${data.periodLabel.title} Income`}
            value={data.periodIncome.total}
            currency={data.periodIncome.currency}
            subtitle={data.periodLabel.subtitle}
            sparkData={data.incomeHistory}
          />
          </div>
          <div data-walkthrough="walkthrough-savings">
          <KpiSparkCard
            title="Saving from Income"
            value={data.savingsRate.percentage}
            valueFormat="percentage"
            currency={data.savingsRate.currency}
            subtitle={`${formatCurrency(data.savingsRate.amount, data.savingsRate.currency, { showSign: true })} before allocations · ${data.periodLabel.subtitle}`}
            sparkData={[]}
          />
          </div>
        </div>

        {/* Row 2: Charts */}
        <div className="grid gap-4 md:grid-cols-5">
          <div data-walkthrough="walkthrough-profit-loss" className="min-w-0 md:col-span-3">
          <ProfitLossChart
            data={data.incomeExpense}
            currency={data.balance.currency}
          />
          </div>
          <div data-walkthrough="walkthrough-category" className="min-w-0 md:col-span-2">
          <SpendingByCategoryChart
            data={data.spendingByCategory.categories}
            total={data.spendingByCategory.total}
            currency={data.balance.currency}
            limit={4}
            periodTitle={data.periodLabel.title}
            accountIds={accountIds}
            dateFrom={dateFromParam}
            dateTo={dateToParam}
            horizon={effectiveHorizon}
          />
          </div>
        </div>

        <CashFlowSummary data={data.cashFlow} currency={data.balance.currency} reconciliation={data.cashReconciliation} />

        {/* Row 3: Cash Flow Sankey */}
        <div className="grid min-w-0 grid-cols-1 gap-4">
          <div data-walkthrough="walkthrough-cash-flow">
          <SankeyFlowChart
            data={data.sankeyData}
            currency={data.balance.currency}
            subtitle={data.periodLabel.subtitle}
            accountIds={accountIds}
            dateFrom={dateFromParam}
            dateTo={dateToParam}
            horizon={effectiveHorizon}
          />
          </div>
        </div>

        {/* Row 4: Upcoming Irregular Expenses */}
        <div className="grid min-w-0 grid-cols-1 gap-4">
          <UpcomingPlannedExpensesCard data={data.upcomingPlannedExpenses} />
        </div>

        {/* Row 5: Assets Overview */}
        <div className="grid min-w-0 grid-cols-1 gap-4">
          <Suspense fallback={<CardLoading label="Loading personal net worth" />}>
            <NetWorthTotals />
          </Suspense>
          <Suspense fallback={<CardLoading label="Loading assets overview" height="h-64" />}>
            <AssetsOverviewSection accountIds={accountIds} personId={personId} />
          </Suspense>
        </div>

        {/* Row 6: Investments Summary */}
        <div className="grid min-w-0 grid-cols-1 gap-4">
          <Suspense fallback={<CardLoading label="Loading investments" />}>
            <PortfolioSummaryCard />
          </Suspense>
        </div>
    </div>
  );
}
