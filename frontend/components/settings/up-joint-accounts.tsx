"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { upJointRequest, downloadUpArchive } from "@/lib/actions/bank-connections";
type Pair = { source_account_id: string; canonical_account_id: string };
type Account = { account_id: string; name: string; currency: string; connected: boolean; originals: { id: string; name: string; transactions: number }[] };
type Data = { accounts: Account[]; archives: { id: string; name: string }[] };
type Review = { pairs: Pair[]; transactions_to_move: number; provider_duplicates: number; conflicts: { transaction_id: string; date: string; fields: string[] }[]; blocked: string[] };
export function UpJointAccounts({ connectionId }: { connectionId: string }) {
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [strategy, setStrategy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function refresh() { setData(await upJointRequest(connectionId, "joint-accounts")); }
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "Request failed"); }
    finally { setBusy(false); }
  }
  return <div className="mt-3 space-y-3 text-sm">
    <Button variant="outline" size="sm" disabled={busy} onClick={() => run(refresh)}>Review joint Up accounts</Button>
    {busy && <p role="status">Updating joint accounts…</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {data && <div className="space-y-3">
      <p>Your Up token stays private. Only accounts already shared with you appear here. Either person can sync the same account with one balance and history.</p>
      {!data.accounts.length && <p>No shared Up accounts available.</p>}
      {data.accounts.map(account => <div key={account.account_id} className="space-y-2 rounded border p-3">
        <p className="font-medium">{account.name} ({account.currency})</p>
        {!!account.originals.length && <p>Your previous imports: {account.originals.map(source => `${source.name} (${source.transactions} transactions)`).join(", ")}.</p>}
        {account.originals.length ? <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => {
          const pairs = account.originals.map(source => ({ source_account_id: source.id, canonical_account_id: account.account_id }));
          setReview({ ...await upJointRequest(connectionId, "joint-preview", { pairs }), pairs }); setStrategy("");
        })}>Preview consolidation</Button> : <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => {
          await upJointRequest(connectionId, "joint-source", { account_id: account.account_id, enabled: !account.connected });
          await refresh(); setNotice(account.connected ? "Your connection no longer imports this account." : "Connected. Sync now to verify this account with Up and import transactions."); router.refresh();
        })}>{account.connected ? "Stop my imports" : "Sync through my connection"}</Button>}
      </div>)}
      {review && <div className="space-y-3 rounded border p-3" aria-label="Consolidation preview">
        <p>{review.transactions_to_move} transactions will move; {review.provider_duplicates} exact Up duplicates will combine. Original histories and ownership records are archived privately.</p>
        {review.blocked.map(message => <p key={message} role="alert">{message}. Keep the originals until these links are reviewed.</p>)}
        {!!review.conflicts.length && <>
          <p>{review.conflicts.length} duplicate transactions have different details. Choose which details to keep; missing details are retained from either copy.</p>
          <ul>{review.conflicts.map(conflict => <li key={conflict.transaction_id}>{conflict.date.slice(0, 10)}: {conflict.fields.join(", ")}</li>)}</ul>
          <label>Details to retain <select aria-label="Details to retain" value={strategy} onChange={e => setStrategy(e.target.value)} className="border p-2">
            <option value="">Choose…</option><option value="keep_shared">Existing shared account details</option><option value="keep_mine">My original import details</option>
          </select></label>
        </>}
        <Button size="sm" disabled={busy || !!review.blocked.length || (!!review.conflicts.length && !strategy)} onClick={() => run(async () => {
          const result = await upJointRequest(connectionId, "joint-reconcile", { pairs: review.pairs, conflict_strategy: strategy || null });
          setReview(null); await refresh(); setNotice(`Consolidated ${result.accounts_consolidated} accounts. Your private connection now imports into the shared account.`); router.refresh();
        })}>Consolidate reviewed imports</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReview(null)}>Cancel</Button>
      </div>}
      {data.archives.map(archive => <Button key={archive.id} size="sm" variant="outline" disabled={busy} onClick={() => run(async () => {
        const original = await downloadUpArchive(archive.id);
        const url = URL.createObjectURL(new Blob([JSON.stringify(original, null, 2)], { type: "application/json" }));
        const link = document.createElement("a"); link.href = url; link.download = `up-original-${archive.id}.json`; link.click(); URL.revokeObjectURL(url);
      })}>Download my original history: {archive.name}</Button>)}
    </div>}
  </div>;
}
