"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  RiExternalLinkLine,
  RiEyeLine,
  RiEyeOffLine,
  RiRefreshLine,
  RiShieldCheckLine,
} from "@remixicon/react";
import { createBrokerConnection } from "@/lib/api/investments";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field, Input } from "./_form-bits";

type Provider = "coinspot" | "ibkr_flex";

export function BrokerForm({ onCancel }: { onCancel: () => void }) {
  const router = useRouter();
  const [provider, setProvider] = useState<Provider>("coinspot");
  const [accountName, setAccountName] = useState("CoinSpot Main");
  const [baseCurrency, setBaseCurrency] = useState("AUD");
  const [token, setToken] = useState("");
  const [tokenVisible, setTokenVisible] = useState(false);
  const [qPos, setQPos] = useState("");
  const [qTrades, setQTrades] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [secretVisible, setSecretVisible] = useState(false);
  const [historyStart, setHistoryStart] = useState("2013-01-01");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const changeProvider = (next: Provider) => {
    setProvider(next);
    setErr(null);
    if (next === "coinspot") {
      setAccountName("CoinSpot Main");
      setBaseCurrency("AUD");
    } else {
      setAccountName("IBKR Main");
      setBaseCurrency("EUR");
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (provider === "coinspot") {
        await createBrokerConnection({
          provider,
          api_key: apiKey,
          api_secret: apiSecret,
          history_start_date: historyStart,
          account_name: accountName,
          base_currency: "AUD",
        });
      } else {
        await createBrokerConnection({
          provider,
          flex_token: token,
          query_id_positions: qPos,
          query_id_trades: qTrades,
          account_name: accountName,
          base_currency: baseCurrency,
        });
      }
      router.push("/investments");
      router.refresh();
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-t-2 border-t-primary">
      <CardContent className="p-6">
        <form onSubmit={submit} className="space-y-5">
          <Field label="Provider">
            <Select
              value={provider}
              onValueChange={(value) => value && changeProvider(value as Provider)}
            >
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="coinspot">CoinSpot · read-only API</SelectItem>
                <SelectItem value="ibkr_flex">Interactive Brokers · Flex Query</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <div className="flex items-center gap-3">
            <div className="w-9 h-9 border border-border flex items-center justify-center font-bold text-[10px] text-muted-foreground">
              {provider === "coinspot" ? "CS" : "IBKR"}
            </div>
            <div>
              <div className="font-semibold text-sm">
                {provider === "coinspot" ? "CoinSpot" : "Interactive Brokers"}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {provider === "coinspot"
                  ? "Balances and completed activity sync through CoinSpot V2"
                  : "Positions and trade history sync through the Flex Web Service"}
              </div>
            </div>
          </div>

          {provider === "coinspot" ? (
            <div className="bg-muted/40 border border-border px-4 py-3 space-y-2">
              <div className="flex gap-2 text-xs font-medium">
                <RiShieldCheckLine size={15} className="shrink-0 text-emerald-600" />
                Read-only by design
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Syllogic is locked to CoinSpot&apos;s documented <code>/api/v2/ro</code>
                namespace. It cannot place trades or request withdrawals. Generate a Read Only
                API key in CoinSpot, then paste its key and secret below.
              </p>
              <a
                href="https://www.coinspot.com.au/v2/api"
                target="_blank"
                rel="noreferrer"
                className="text-xs text-foreground inline-flex items-center gap-1 hover:underline"
              >
                <RiExternalLinkLine size={11} /> CoinSpot V2 API guide
              </a>
            </div>
          ) : (
            <div className="bg-muted/40 border border-border px-4 py-3 space-y-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">What you need</div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Create a Flex Web Service token plus separate Positions and Trades Flex
                Query IDs in IBKR Account Management.
              </p>
              <a
                href="https://www.interactivebrokers.com/en/index.php?f=1325"
                target="_blank"
                rel="noreferrer"
                className="text-xs text-foreground inline-flex items-center gap-1 hover:underline"
              >
                <RiExternalLinkLine size={11} /> IBKR Flex Query guide
              </a>
            </div>
          )}

          <div className="space-y-3.5">
            <div className="flex gap-3">
              <Field label="Account name" className="flex-[2_1_0%]">
                <Input required value={accountName} onChange={(event) => setAccountName(event.target.value)} />
              </Field>
              <Field label="Base currency" className="flex-1">
                {provider === "coinspot" ? (
                  <Input value="AUD" disabled />
                ) : (
                  <Select value={baseCurrency} onValueChange={(value) => value && setBaseCurrency(value)}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="EUR">EUR</SelectItem>
                      <SelectItem value="USD">USD</SelectItem>
                      <SelectItem value="AUD">AUD</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </Field>
            </div>

            {provider === "coinspot" ? (
              <>
                <Field label="API key">
                  <Input required autoComplete="off" placeholder="Paste your CoinSpot API key" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
                </Field>
                <Field label="API secret">
                  <div className="relative">
                    <Input
                      required
                      autoComplete="new-password"
                      type={secretVisible ? "text" : "password"}
                      placeholder="Paste your CoinSpot API secret"
                      value={apiSecret}
                      onChange={(event) => setApiSecret(event.target.value)}
                      className="pr-9"
                    />
                    <button
                      type="button"
                      aria-label={secretVisible ? "Hide API secret" : "Show API secret"}
                      onClick={() => setSecretVisible((value) => !value)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {secretVisible ? <RiEyeOffLine size={13} /> : <RiEyeLine size={13} />}
                    </button>
                  </div>
                </Field>
                <Field label="Import history from">
                  <Input
                    required
                    type="date"
                    min="2013-01-01"
                    max={new Date().toISOString().slice(0, 10)}
                    value={historyStart}
                    onChange={(event) => setHistoryStart(event.target.value)}
                  />
                  <div className="text-[11px] text-muted-foreground mt-1.5">
                    The first sync backfills from this date. Later syncs overlap the last two days safely.
                  </div>
                </Field>
              </>
            ) : (
              <>
                <Field label="Flex token">
                  <div className="relative">
                    <Input
                      required
                      type={tokenVisible ? "text" : "password"}
                      placeholder="Paste your Flex Web Service token"
                      value={token}
                      onChange={(event) => setToken(event.target.value)}
                      className="pr-9"
                    />
                    <button
                      type="button"
                      aria-label={tokenVisible ? "Hide Flex token" : "Show Flex token"}
                      onClick={() => setTokenVisible((value) => !value)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {tokenVisible ? <RiEyeOffLine size={13} /> : <RiEyeLine size={13} />}
                    </button>
                  </div>
                </Field>
                <div className="flex gap-3">
                  <Field label="Positions query ID" className="flex-1">
                    <Input required value={qPos} onChange={(event) => setQPos(event.target.value)} />
                  </Field>
                  <Field label="Trades query ID" className="flex-1">
                    <Input required value={qTrades} onChange={(event) => setQTrades(event.target.value)} />
                  </Field>
                </div>
              </>
            )}

            {err && <div role="alert" className="text-destructive text-xs">{err}</div>}
            <div className="flex justify-between items-center pt-1">
              <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
              <Button type="submit" disabled={busy}>
                <RiRefreshLine className={busy ? "animate-spin" : ""} size={13} />
                {busy ? "Connecting…" : "Connect & sync"}
              </Button>
            </div>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
