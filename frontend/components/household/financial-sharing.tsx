"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { TransitionReview, type TransitionReviewData } from "./transition-review";
import { Button } from "@/components/ui/button";

type SharedResource = { id: string; name: string; sharedWith: string[] };
type Sharing = { properties?: SharedResource[]; members: { id: string; name: string | null }[]; accounts: { id: string; name: string; sharedWith: string[] }[]; netWorthSharedWith: string[] };
type SharingChange = { resource: "property"; propertyId: string; memberUserIds: string[] } | { resource: "account"; accountId: string; memberUserIds: string[] } | { resource: "net-worth"; memberUserIds: string[] };
export function FinancialSharing() {
  const router = useRouter();
  const [data, setData] = useState<Sharing | null>(null);
  const [draft, setDraft] = useState<Sharing | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<(TransitionReviewData & { body: SharingChange }) | null>(null);
  async function refresh() {
    const response = await fetch("/api/household/sharing", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load sharing settings");
    setData(result);
  }
  useEffect(() => { refresh().catch((e) => setError(e.message)); }, []);
  async function save(body: SharingChange, confirmation?: string) {
    if (!data || busy) return;
    if (body.resource === "account" && !confirmation) {
      setBusy(true); setError("");
      try {
        const response = await fetch("/api/household/sharing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, phase: "preview" }) });
        const review = await response.json();
        if (!response.ok) throw new Error(review.error || "Could not preview sharing");
        const plan=review?.preview;
        if(typeof review?.confirmation!=="string" || !review.confirmation || !plan || plan.action!=="share-account" || typeof plan.accountPolicy!=="string" ||
          ![plan.accounts,plan.properties,plan.recipients,plan.revokedRecipients,plan.categoryMappings,plan.categoryConflicts,plan.effects].every(Array.isArray)) {
          throw new Error("Could not load a complete access preview. No sharing change was submitted.");
        }
        setPending({ ...review, body });
      } catch (error) { setError(error instanceof Error ? error.message : "Could not preview sharing"); }
      finally { setBusy(false); }
      return;
    }
    setDraft(body.resource === "account"
      ? { ...data, accounts: data.accounts.map((account) => account.id === body.accountId ? { ...account, sharedWith: body.memberUserIds } : account) }
      : body.resource === "property"
        ? { ...data, properties: (data.properties ?? []).map(property => property.id === body.propertyId ? { ...property, sharedWith: body.memberUserIds } : property) }
        : { ...data, netWorthSharedWith: body.memberUserIds });
    setBusy(true); setError("");
    let denied = false;
    try {
      const response = await fetch("/api/household/sharing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, confirmation }) });
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
    finally { setDraft(null); setBusy(false); setPending(null); }
  }
  const toggle = (ids: string[], id: string) => ids.includes(id) ? ids.filter((v) => v !== id) : [...ids, id];
  return <section className="space-y-4 rounded-md border p-4">
    <h3 className="font-medium">Financial privacy</h3>
    <p className="text-sm text-muted-foreground">Your accounts, properties, net worth and bank connections are private by default. Choose who can view and edit each account and property. Sharing never gives access to your bank connection or token.</p>
    <p className="text-sm text-muted-foreground">Ownership percentages affect totals. Sharing separately controls who can see and edit each account or property.</p>
    {pending && <TransitionReview review={pending} busy={busy} memberName={id => data?.members.find(member => member.id === id)?.name ?? "Household member"} onConfirm={() => void save(pending.body, pending.confirmation)} onCancel={() => setPending(null)} />}
    {busy && <p role="status" className="text-sm text-muted-foreground">{!pending && !draft ? "Preparing access review…" : "Saving sharing settings…"}</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {!data && !error && <p>Loading sharing settings…</p>}
    {data && !data.members.length && <p className="text-sm">Invite someone to your household to share an account.</p>}
    {!!data?.members.length && <>
      {data.accounts.map((account) => <fieldset key={account.id} className="space-y-2 border-t pt-3" disabled={busy || !!pending}>
        <legend className="font-medium">{account.name}</legend>
        <p className="text-sm text-muted-foreground">{account.sharedWith.length ? "Shared · selected members can view and edit" : "Private · only you"}</p>
        {data.members.map((member) => <label key={member.id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={(draft?.accounts.find((a) => a.id === account.id) ?? account).sharedWith.includes(member.id)} onChange={() => save({ resource: "account", accountId: account.id, memberUserIds: toggle(account.sharedWith, member.id) })} />
          Share {account.name} with {member.name || "Household member"}
        </label>)}
      </fieldset>)}
      {(data.properties ?? []).map(property => <fieldset key={property.id} className="space-y-2 border-t pt-3" disabled={busy || !!pending}>
        <legend className="font-medium">{property.name}</legend>
        <p className="text-sm text-muted-foreground">{property.sharedWith.length ? "Shared · selected members can view and edit property details and valuations" : "Private · only you"}</p>
        <p className="text-sm text-muted-foreground">Share linked mortgage accounts separately in the account settings above. Property reports include only transactions from accounts each member can access.</p>
        {data.members.map(member => <label key={member.id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={(draft?.properties?.find(p => p.id === property.id) ?? property).sharedWith.includes(member.id)} onChange={() => save({ resource: "property", propertyId: property.id, memberUserIds: toggle(property.sharedWith, member.id) })} />
          Share property {property.name} with {member.name || "Household member"}
        </label>)}
      </fieldset>)}
      <fieldset className="space-y-2 border-t pt-3" disabled={busy || !!pending}>
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
