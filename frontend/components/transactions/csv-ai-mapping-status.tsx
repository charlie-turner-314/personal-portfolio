"use client";

import {
  RiCheckboxCircleLine,
  RiErrorWarningLine,
  RiSparklingLine,
  RiTimeLine,
} from "@remixicon/react";
import { Button } from "@/components/ui/button";

export type AiMappingStatus = "idle" | "analyzing" | "succeeded" | "failed" | "timed_out";

interface CsvAiMappingStatusProps {
  status: AiMappingStatus;
  error?: string;
  onRetry: () => void;
  onMapManually: () => void;
}

export function CsvAiMappingStatus({
  status,
  error,
  onRetry,
  onMapManually,
}: CsvAiMappingStatusProps) {
  if (status === "idle") {
    return null;
  }

  if (status === "analyzing") {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-lg border bg-muted/50 px-4 py-3" role="status">
        <RiSparklingLine className="h-4 w-4 animate-pulse text-primary" />
        <span className="text-sm">
          Analyzing headers and sample transactions. This can take up to 30 seconds.
        </span>
      </div>
    );
  }

  if (status === "succeeded") {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-lg border bg-muted/50 px-4 py-3" role="status">
        <RiCheckboxCircleLine className="h-4 w-4 text-primary" />
        <span className="text-sm">
          AI mapping applied. Review the suggested fields before previewing transactions.
        </span>
      </div>
    );
  }

  const timedOut = status === "timed_out";
  const message = error ?? (timedOut
    ? "AI analysis timed out. Try again or map the columns manually."
    : "AI could not analyze this CSV. Try again or map the columns manually.");

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3" role="alert">
      {timedOut ? (
        <RiTimeLine className="h-4 w-4 shrink-0 text-destructive" />
      ) : (
        <RiErrorWarningLine className="h-4 w-4 shrink-0 text-destructive" />
      )}
      <span className="min-w-0 flex-1 text-sm">{message}</span>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        Retry AI analysis
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onMapManually}>
        Map columns manually
      </Button>
    </div>
  );
}
