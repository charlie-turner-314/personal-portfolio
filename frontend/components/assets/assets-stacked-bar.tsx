"use client";

import type { AssetCategory } from "./types";

interface AssetsStackedBarProps {
  categories: AssetCategory[];
  total: number;
}

export function AssetsStackedBar({ categories, total }: AssetsStackedBarProps) {
  const activeCategories = categories.filter((cat) => cat.isActive && cat.value > 0);

  if (activeCategories.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
          <div className="text-sm font-medium">Gross asset allocation</div>
          <div className="text-xs text-muted-foreground">
            Positive asset balances only
          </div>
        </div>
        <div className="h-3 w-full rounded-sm bg-muted" />
        <div className="text-sm text-muted-foreground">
          No positive assets tracked
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <div className="text-sm font-medium">Gross asset allocation</div>
        <div className="text-xs text-muted-foreground">
          Positive asset balances only
        </div>
      </div>

      <div
        className="flex h-3 w-full overflow-hidden rounded-sm"
        aria-label={`Gross asset allocation across ${total} in positive assets`}
      >
        {activeCategories.map((category) => (
          <div
            key={category.key}
            className="h-full transition-all"
            style={{
              width: `${category.percentage}%`,
              backgroundColor: category.color,
            }}
          />
        ))}
      </div>

      <div className="flex flex-wrap gap-4">
        {activeCategories.map((category) => (
          <div key={category.key} className="flex min-w-0 items-center gap-2">
            <div
              className="h-3 w-3 rounded-sm"
              style={{ backgroundColor: category.color }}
            />
            <span className="truncate text-sm text-muted-foreground">
              {category.label}
            </span>
            <span className="shrink-0 text-sm font-medium">
              {category.percentage.toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
