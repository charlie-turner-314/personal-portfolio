"use client";

import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { AssetsStackedBar } from "./assets-stacked-bar";
import { AssetsTable } from "./assets-table";
import { AddAssetDialog } from "./add-asset-dialog";
import type { AssetsOverviewData } from "./types";

interface AssetsOverviewCardProps {
  data: AssetsOverviewData;
}

export function AssetsOverviewCard({ data }: AssetsOverviewCardProps) {
  const router = useRouter();
  const grossAssets = data.grossAssets;
  const totalLiabilities = data.totalLiabilities;
  const netWorth = data.netWorth;

  const handleAssetAdded = () => {
    router.refresh();
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle>Assets and liabilities</CardTitle>
            <AddAssetDialog onAssetAdded={handleAssetAdded} />
          </div>
          <div className="min-w-0 text-left sm:text-right">
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Visible balance
            </div>
            <div className="break-words text-3xl font-bold leading-tight sm:text-2xl">
              {netWorth === null ? "Unavailable" : formatCurrency(netWorth, data.currency, { showSign: true })}
            </div>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          {data.scope || "Your visible finances"} · Current values{data.accountFiltered ? " · Selected accounts only" : ""}
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {data.coveredAccounts && <p className="text-sm text-muted-foreground">Active permitted accounts covered: {data.coveredAccounts.map(account=>account.name).join(", ") || "None"}. Other private accounts are outside this report.</p>}
        {!!data.missingValues?.length && <p role="status" className="text-sm text-muted-foreground">Complete totals are unavailable while valuations or currency conversions are missing for {data.missingValues.join(", ")}. The breakdown shows known values only.</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0 border-t pt-3">
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Gross assets
            </div>
            <div className="break-words text-lg font-semibold">
              {grossAssets === null ? "Unavailable" : formatCurrency(grossAssets, data.currency)}
            </div>
          </div>
          <div className="min-w-0 border-t pt-3">
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Total liabilities
            </div>
            <div className="break-words text-lg font-semibold text-red-600 dark:text-red-400">
              {totalLiabilities === null ? "Unavailable" : formatCurrency(-Math.abs(totalLiabilities), data.currency, { showSign: true })}
            </div>
          </div>
        </div>
        <AssetsStackedBar categories={data.categories} total={grossAssets ?? data.knownGrossAssets ?? 0} />
        <AssetsTable
          categories={data.categories}
          currency={data.currency}
          liabilities={data.liabilities}
          superannuation={data.superannuation}
        />
      </CardContent>
    </Card>
  );
}
