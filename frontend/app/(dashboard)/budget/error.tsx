"use client";

import { useEffect } from "react";
import { RiErrorWarningLine, RiRefreshLine } from "@remixicon/react";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[budget] Failed to load budget page", {
      digest: error.digest ?? null,
    });
  }, [error]);

  return (
    <>
      <Header title="Budget" />
      <div className="flex flex-1 flex-col p-4 pt-0">
        <Card className="max-w-xl">
          <CardHeader>
            <div className="flex items-center gap-2">
              <RiErrorWarningLine
                className="size-4 text-destructive"
                aria-hidden="true"
              />
              <CardTitle>Budget failed to load</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col items-start gap-4">
            <p className="text-muted-foreground">
              Refresh the budget data and try again.
            </p>
            {error.digest && (
              <p className="text-xs text-muted-foreground">
                Reference: {error.digest}
              </p>
            )}
            <Button type="button" onClick={reset}>
              <RiRefreshLine aria-hidden="true" />
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
