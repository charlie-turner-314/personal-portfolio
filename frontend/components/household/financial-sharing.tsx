"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type Sharing = { members: { id: string; name: string | null }[]; accounts: { id: string; name: string; sharedWith: string[] }[]; netWorthSharedWith: string[] };
type SharingChange = { resource: "account"; accountId: string; memberUserIds: string[] } | { resource: "net-worth"; memberUserIds: string[] };
export function FinancialSharing() {
  const router = useRouter();
  const [data, setData] = useState<Sharing | null>(null);
  const [draft, setDraft] = useState<Sharing | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function refresh() {
    const response = await fetch("/api/household/sharing", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load sharing settings");
    setData(result);
  }
  useEffect(() => { refresh().catch((e) => setError(e.message)); }, []);
  async function save(body: SharingChange) {
    if (!data || busy) return;
    setDraft(body.resource === "account"
      ? { ...data, accounts: data.accounts.map((account) => account.id === body.accountId ? { ...account, sharedWith: body.memberUserIds } : account) }
      : { ...data, netWorthSharedWith: body.memberUserIds });
    setBusy(true); setError("");
    let denied = false;
    try {
      const response = await fetch("/api/household/sharing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) { denied = response.status >= 400 && response.status < 500; throw new Error(result.error || "Could not update sharing"); }
      await refresh(); router.refresh();
    } catch (e) {
      if (denied) setError(e instanceof Error ? e.message : "Could not update sharing");
      else {
        // A lost response may follow a committed change. Never claim privacy
        // from an old selection when the server's current state is unknown.
        try { await refresh(); setError("Sharing settings were reloaded after a connection problem. Check the current selection."); }
        catch { setData(null); setError("Could not confirm sharing settings. Reload them before assuming access has changed."); }
      }
    }
    finally { setDraft(null); setBusy(false); }
  }
  const toggle = (ids: string[], id: string) => ids.includes(id) ? ids.filter((v) => v !== id) : [...ids, id];
  return <section className="space-y-4 rounded-md border p-4">
    <h3 className="font-medium">Financial privacy</h3>
    <p className="text-sm text-muted-foreground">Your accounts, net worth and bank connections are private by default. Choose who can view and edit each account. Sharing never gives access to your bank connection or token.</p>
    <p className="text-sm text-muted-foreground">Ownership percentages affect totals. Sharing separately controls who can see and edit an account.</p>
    {busy && <p role="status" className="text-sm text-muted-foreground">Saving sharing settings…</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {!data && !error && <p>Loading sharing settings…</p>}
    {data && !data.members.length && <p className="text-sm">Invite someone to your household to share an account.</p>}
    {!!data?.members.length && <>
      {data.accounts.map((account) => <fieldset key={account.id} className="space-y-2 border-t pt-3" disabled={busy}>
        <legend className="font-medium">{account.name}</legend>
        <p className="text-sm text-muted-foreground">{account.sharedWith.length ? "Shared · selected members can view and edit" : "Private · only you"}</p>
        {data.members.map((member) => <label key={member.id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={(draft?.accounts.find((a) => a.id === account.id) ?? account).sharedWith.includes(member.id)} onChange={() => save({ resource: "account", accountId: account.id, memberUserIds: toggle(account.sharedWith, member.id) })} />
          Share {account.name} with {member.name || "Household member"}
        </label>)}
      </fieldset>)}
      <fieldset className="space-y-2 border-t pt-3" disabled={busy}>
        <legend className="font-medium">Your net worth</legend>
        <p className="text-sm text-muted-foreground">Share your total only. Your private accounts and transactions stay private.</p>
        {data.members.map((member) => <label key={member.id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={(draft ?? data).netWorthSharedWith.includes(member.id)} onChange={() => save({ resource: "net-worth", memberUserIds: toggle(data.netWorthSharedWith, member.id) })} />
          Share your net worth total with {member.name || "Household member"}
        </label>)}
      </fieldset>
    </>}
    {error && <Button variant="outline" disabled={busy} onClick={() => refresh().then(() => setError("")).catch((e) => setError(e.message))}>Retry</Button>}
  </section>;
}
