"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  RiDeleteBinLine,
  RiErrorWarningLine,
  RiRefreshLine,
  RiShieldCheckLine,
} from "@remixicon/react";
import {
  disconnectBrokerConnection,
  syncBrokerConnection,
  updateCoinSpotCredentials,
  type BrokerConnection,
} from "@/lib/api/investments";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const STATUS_LABELS: Record<string, string> = {
  ok: "Healthy",
  partial: "Review difference",
  needs_reauth: "Key rejected",
  pending: "Sync pending",
  error: "Sync failed",
};

function dateTimeLabel(value: string | null): string {
  if (!value) return "Never";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString("en-AU");
}

export function BrokerConnectionsPanel({
  connections,
  readOnly = false,
}: {
  connections: BrokerConnection[];
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reconnectId, setReconnectId] = useState<string | null>(null);
  const [replacementKey, setReplacementKey] = useState("");
  const [replacementSecret, setReplacementSecret] = useState("");

  const pendingKey = connections
    .filter((connection) => connection.last_sync_status === "pending")
    .map((connection) => connection.id)
    .join(",");
  useEffect(() => {
    if (!pendingKey) return;
    const interval = window.setInterval(() => router.refresh(), 10_000);
    return () => window.clearInterval(interval);
  }, [pendingKey, router]);

  if (connections.length === 0) return null;

  const refresh = async (connection: BrokerConnection) => {
    setBusyId(connection.id);
    try {
      await syncBrokerConnection(connection.id);
      toast.success(`${connection.account_name} sync queued`);
      setTimeout(() => router.refresh(), 4_000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Sync failed");
    } finally {
      setBusyId(null);
    }
  };

  const disconnect = async (connection: BrokerConnection) => {
    if (!window.confirm(
      `Disconnect ${connection.account_name}? Imported history stays in your portfolio and the encrypted credentials are removed.`,
    )) return;
    setBusyId(connection.id);
    try {
      await disconnectBrokerConnection(connection.id);
      toast.success(`${connection.account_name} disconnected`);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Disconnect failed");
    } finally {
      setBusyId(null);
    }
  };

  const reconnect = async (connection: BrokerConnection) => {
    setBusyId(connection.id);
    try {
      await updateCoinSpotCredentials(connection.id, {
        api_key: replacementKey,
        api_secret: replacementSecret,
      });
      setReplacementKey("");
      setReplacementSecret("");
      setReconnectId(null);
      toast.success(`${connection.account_name} key verified; sync queued`);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Key verification failed");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold">Connected providers</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              Connection health, balance reconciliation, and sync controls
            </div>
          </div>
        </div>
        <div className="divide-y divide-border border border-border">
          {connections.map((connection) => {
            const status = connection.last_sync_status || "pending";
            const differences = connection.health_details.differences || [];
            const isBusy = busyId === connection.id;
            const isProblem = status === "error" || status === "needs_reauth";
            return (
              <div key={connection.id} className="p-3.5 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="font-medium text-sm">{connection.account_name}</div>
                  <Badge variant={isProblem ? "destructive" : status === "partial" ? "outline" : "secondary"}>
                    {STATUS_LABELS[status] || status}
                  </Badge>
                  {connection.read_only_verified_at && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400">
                      <RiShieldCheckLine size={12} /> Read-only verified
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-1.5">
                    {status === "needs_reauth" && !readOnly && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setReconnectId((current) => current === connection.id ? null : connection.id)}
                      >
                        Replace key
                      </Button>
                    )}
                    {!readOnly && (
                      <>
                        <Button size="sm" variant="outline" disabled={isBusy} onClick={() => refresh(connection)}>
                          <RiRefreshLine className={isBusy ? "animate-spin" : ""} /> Refresh
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Disconnect ${connection.account_name}`}
                          disabled={isBusy}
                          onClick={() => disconnect(connection)}
                        >
                          <RiDeleteBinLine />
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                  <div>Provider: <span className="text-foreground">{connection.provider === "coinspot" ? "CoinSpot" : "IBKR Flex"}</span></div>
                  <div>Last successful sync: <span className="text-foreground">{dateTimeLabel(connection.last_sync_at)}</span></div>
                  <div>
                    Balance check:{" "}
                    <span className="text-foreground">
                      {connection.health_details.balances_reconciled === undefined
                        ? "Waiting for first sync"
                        : connection.health_details.balances_reconciled ? "Reconciled" : "Difference found"}
                    </span>
                  </div>
                </div>

                {connection.last_sync_error && (
                  <div role="alert" className="flex gap-2 border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">
                    <RiErrorWarningLine size={14} className="shrink-0" />
                    <span>{connection.last_sync_error}</span>
                  </div>
                )}

                {reconnectId === connection.id && connection.provider === "coinspot" && (
                  <form
                    className="grid gap-2 border border-border bg-muted/30 p-3 sm:grid-cols-[1fr_1fr_auto]"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void reconnect(connection);
                    }}
                  >
                    <Input
                      required
                      autoComplete="off"
                      aria-label="Replacement CoinSpot API key"
                      placeholder="New Read Only API key"
                      value={replacementKey}
                      onChange={(event) => setReplacementKey(event.target.value)}
                    />
                    <Input
                      required
                      type="password"
                      autoComplete="new-password"
                      aria-label="Replacement CoinSpot API secret"
                      placeholder="New API secret"
                      value={replacementSecret}
                      onChange={(event) => setReplacementSecret(event.target.value)}
                    />
                    <Button type="submit" disabled={isBusy}>Verify & sync</Button>
                  </form>
                )}

                {differences.length > 0 && (
                  <div className="overflow-x-auto border border-border">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50 text-muted-foreground">
                        <tr>
                          <th className="px-2.5 py-2 text-left font-medium">Asset</th>
                          <th className="px-2.5 py-2 text-right font-medium">Activity ledger</th>
                          <th className="px-2.5 py-2 text-right font-medium">CoinSpot</th>
                          <th className="px-2.5 py-2 text-right font-medium">Difference</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {differences.map((difference) => (
                          <tr key={difference.symbol}>
                            <td className="px-2.5 py-2 font-medium">{difference.symbol}</td>
                            <td className="px-2.5 py-2 text-right tabular-nums">{difference.activity_quantity}</td>
                            <td className="px-2.5 py-2 text-right tabular-nums">{difference.provider_quantity}</td>
                            <td className="px-2.5 py-2 text-right tabular-nums text-amber-700 dark:text-amber-400">{difference.difference}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {connection.next_retry_at && (
                  <div className="text-[11px] text-muted-foreground">
                    Automatic retry after {dateTimeLabel(connection.next_retry_at)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
