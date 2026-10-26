"use client";
import { useEffect, useState } from "react";
import { TransitionReview, type TransitionReviewData } from "./transition-review";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Access = { isOwner: boolean; personId: string | null; ownerName: string;
  members: { personId: string; email: string }[];
  invitations: { personId: string; email: string; expiresAt: string }[] };
export function HouseholdAccess({ people }: { people: { id: string; name: string; kind: string }[] }) {
  const [access, setAccess] = useState<Access | null>(null);
  const [personId, setPersonId] = useState("");
  const [email, setEmail] = useState("");
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<(TransitionReviewData & { body: { action: string; personId?: string } }) | null>(null);
  async function refresh() {
    const response = await fetch("/api/household", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load household access");
    setAccess(data);
  }
  useEffect(() => { refresh().catch((e) => setError(e.message)); }, []);
  async function request(body: { action: string; personId?: string; email?: string }, confirmation?: string) {
    setBusy(true); setError(""); setLink("");
    try {
      const response = await fetch("/api/household", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, phase: body.action !== "invite" && !confirmation ? "preview" : "commit", confirmation }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not update household");
      if (result.preview) { setPending({ ...result, body }); return false; }
      setPending(null);
      if (result.token) setLink(`${window.location.origin}/household/join?token=${result.token}`);
      await refresh();
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : "Could not update household"); return false; }
    finally { setBusy(false); }
  }
  return <section className="space-y-4 rounded-md border p-4">
    <h3 className="font-medium">Household logins</h3>
    {pending && <TransitionReview review={pending} busy={busy} onCancel={() => setPending(null)} onConfirm={async () => {
      if (await request(pending.body, pending.confirmation) && ["leave", "dissolve"].includes(pending.body.action)) window.location.assign("/");
    }} />}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {!access && !error && <p>Loading household access…</p>}
    {access && !access.isOwner && <>
      <p>You are a member of {access.ownerName}’s household. You can view and edit shared finances. The owner manages people and invitations.</p>
      <p>Leaving removes shared access in both directions. Your personal accounts, bank connections and ownership history are preserved.</p>
      <Button disabled={busy} variant="outline" onClick={async () => { if (await request({ action: "leave" })) window.location.assign("/"); }}>Leave household</Button>
    </>}
    {access?.isOwner && <>
      <Button variant="outline" disabled={busy || !!pending} onClick={() => void request({ action: "dissolve" })}>Dissolve household</Button>
      <p className="text-sm text-muted-foreground">Invite a placeholder to use their own login. Personal finances and bank connections stay private. Account owners choose which accounts to share; shared accounts can be edited by the selected members. Existing ownership and history stay in place. Links expire after seven days and only work for the invited email.</p>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void request({ action: "invite", personId, email }); }}>
        <label className="block text-sm">Household person
          <select aria-label="Household person" className="mt-1 block w-full rounded border bg-background p-2" required value={personId} onChange={(e) => setPersonId(e.target.value)}>
            <option value="">Choose a person</option>
            {people.filter((p) => p.kind !== "self" && !access.members.some((m) => m.personId === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="block text-sm">Their login email<Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <Button disabled={busy || !personId} type="submit">Create invitation link</Button>
      </form>
      {link && <div className="space-y-2"><p>Share this link privately with the invited person. It is only shown now.</p><Input aria-label="Invitation link" readOnly value={link} onFocus={(e) => e.target.select()} /><Button variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(link); } catch { setError("Select and copy the invitation link above."); } }}>Copy link</Button></div>}
      {[...access.members.map((m) => ({ ...m, state: "Linked login" })), ...access.invitations.map((i) => ({ ...i, state: `Pending until ${new Date(i.expiresAt).toLocaleDateString()}` }))].map((item) => <div key={item.personId} className="flex items-center justify-between gap-3 border-t pt-3"><p>{people.find((p) => p.id === item.personId)?.name} · {item.email}<span className="block text-sm text-muted-foreground">{item.state}</span></p><Button disabled={busy} variant="outline" onClick={() => request({ action: "revoke", personId: item.personId })}>Revoke access</Button></div>)}
    </>}
  </section>;
}
