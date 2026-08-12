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
            <CardTitle>Net Worth</CardTitle>
            <AddAssetDialog onAssetAdded={handleAssetAdded} />
          </div>
          <div className="min-w-0 text-left sm:text-right">
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Net worth
            </div>
            <div className="break-words text-3xl font-bold leading-tight sm:text-2xl">
              {formatCurrency(netWorth, data.currency, { showSign: true })}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0 border-t pt-3">
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Gross assets
            </div>
            <div className="break-words text-lg font-semibold">
              {formatCurrency(grossAssets, data.currency)}
            </div>
          </div>
          <div className="min-w-0 border-t pt-3">
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Total liabilities
            </div>
            <div className="break-words text-lg font-semibold">
              {formatCurrency(Math.abs(totalLiabilities), data.currency)}
            </div>
          </div>
        </div>
        <AssetsStackedBar categories={data.categories} total={grossAssets} />
        <AssetsTable
          categories={data.categories}
          currency={data.currency}
          liabilities={data.liabilities}
        />
      </CardContent>
    </Card>
  );
}
