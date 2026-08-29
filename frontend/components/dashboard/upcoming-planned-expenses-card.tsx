"use client";

import { useMemo, useState } from "react";
import { RiCalendarScheduleLine } from "@remixicon/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { UpcomingPlannedExpensesData } from "@/lib/actions/planned-expenses";
import { cn } from "@/lib/utils";

interface UpcomingPlannedExpensesCardProps {
  data: UpcomingPlannedExpensesData;
}

function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDate(dateKey: string): string {
  return new Date(`${dateKey}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function UpcomingPlannedExpensesCard({
  data,
}: UpcomingPlannedExpensesCardProps) {
  const [selectedDays, setSelectedDays] = useState<30 | 60 | 90>(30);
  const selectedHorizon = useMemo(
    () =>
      data.horizons.find((horizon) => horizon.days === selectedDays) ??
      data.horizons[0],
    [data.horizons, selectedDays]
  );
  const topItems = selectedHorizon.items.slice(0, 6);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Upcoming Irregular Expenses</CardTitle>
          <div className="flex border">
            {[30, 60, 90].map((days) => (
              <Button
                key={days}
                type="button"
                variant="ghost"
                size="xs"
                className={cn(
                  "border-r last:border-r-0",
                  selectedDays === days && "bg-muted"
                )}
                onClick={() => setSelectedDays(days as 30 | 60 | 90)}
              >
                {days}d
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <p className="text-xl font-medium tabular-nums">
              {formatCurrency(selectedHorizon.total, data.currency)}
            </p>
            <p className="text-xs text-muted-foreground">
              unpaid over next {selectedHorizon.days} days
            </p>
          </div>
          <Badge variant="outline">{selectedHorizon.items.length} items</Badge>
        </div>

        {topItems.length === 0 ? (
          <div className="border border-dashed p-6 text-center text-xs text-muted-foreground">
            No upcoming irregular expenses.
          </div>
        ) : (
          <div className="space-y-2">
            {topItems.map((item) => (
              <div
                key={item.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{item.name}</p>
                  <p className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                    <RiCalendarScheduleLine className="size-3 shrink-0" />
                    <span className="truncate">
                      {formatDate(item.dueDate)} · {item.categoryName} · {item.accountName}
                    </span>
                  </p>
                </div>
                <div className="text-right text-sm font-medium tabular-nums">
                  {formatCurrency(item.amountRemaining, data.currency)}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
