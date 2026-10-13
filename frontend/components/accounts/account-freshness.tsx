"use client";

import {
  RiAlertLine,
  RiCheckLine,
  RiInformationLine,
  RiUploadCloud2Line,
} from "@remixicon/react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { cn, formatDate } from "@/lib/utils";
import type { AccountFreshness } from "@/lib/account-freshness";

interface AccountFreshnessProps {
  freshness: AccountFreshness;
  onUploadCsv?: () => void;
  compact?: boolean;
}

function sourceLabel(source: AccountFreshness["source"]): string {
  switch (source) {
    case "up":
      return "Up";
    case "api":
      return "Bank feed";
    case "csv":
      return "CSV";
    default:
      return "Manual";
  }
}

function relativeDate(date: Date): string {
  return formatDistanceToNow(new Date(date), { addSuffix: true });
}

export function AccountFreshnessIndicator({
  freshness,
  onUploadCsv,
  compact = false,
}: AccountFreshnessProps) {
  if (freshness.status === "manual") {
    return (
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <RiInformationLine className="size-3.5 shrink-0" />
        <span>
          Manual account
          {freshness.dataThrough && ` · Data through ${formatDate(new Date(freshness.dataThrough), "medium")}`}
        </span>
      </div>
    );
  }

  const isStale = freshness.status === "stale";
  const hasDataThrough = Boolean(freshness.dataThrough);
  const updatedVerb = freshness.source === "csv" ? "Imported" : "Synced";
  const source = sourceLabel(freshness.source);

  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs", isStale ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
      {isStale ? (
        <RiAlertLine className="size-3.5 shrink-0" />
      ) : (
        <RiCheckLine className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      )}
      <span>
        {isStale ? "Update recommended" : `${source} · ${updatedVerb} ${relativeDate(freshness.lastUpdatedAt!)}`}
        {isStale && freshness.lastUpdatedAt && ` · ${updatedVerb.toLowerCase()} ${relativeDate(freshness.lastUpdatedAt)}`}
        {hasDataThrough && ` · Data through ${formatDate(new Date(freshness.dataThrough!), compact ? "short" : "medium")}`}
      </span>
      {isStale && freshness.source === "csv" && onUploadCsv && (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto p-0 text-xs text-amber-700 dark:text-amber-400"
          onClick={onUploadCsv}
        >
          <RiUploadCloud2Line className="size-3.5" />
          Upload CSV
        </Button>
      )}
    </div>
  );
}
