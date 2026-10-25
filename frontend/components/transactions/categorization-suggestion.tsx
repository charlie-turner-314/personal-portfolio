"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { CategoryDisplay } from "@/types";
import {
  markCategorizationSuggestionShown, categorizationTrialAvailable, requestCategorizationSuggestion, reviewCategorizationSuggestion, getCategorizationTrialSummary,
  type CategorizationSuggestion,
} from "@/lib/actions/categorization-suggestions";

function TrialResults() {
  const [results, setResults] = useState<Awaited<ReturnType<typeof getCategorizationTrialSummary>> | null>(null);
  const [error, setError] = useState(false);
  return <details onToggle={event => {
    if (event.currentTarget.open) getCategorizationTrialSummary().then(setResults).catch(() => setError(true));
  }}>
    <summary className="cursor-pointer text-xs text-muted-foreground">Your trial results</summary>
    {results ? <div className="mt-2 space-y-1 text-xs text-muted-foreground">
      <p>{results.requested} suggestions · {results.outcomes.accepted ?? 0} accepted · {results.outcomes.corrected ?? 0} corrected · {results.outcomes.dismissed ?? 0} dismissed</p>
      <p>{results.outcomes.unreviewed ?? 0} not reviewed in this panel</p>
      {results.mean_review_duration_ms !== null && <p>Average elapsed review time: {(results.mean_review_duration_ms / 1000).toFixed(1)} seconds, including pauses.</p>}
    </div> : <p className="mt-2 text-xs text-muted-foreground">{error ? "Unable to load results" : "Loading results…"}</p>}
  </details>;
}

export function CategorizationSuggestionPanel({ transactionId, categories, onCategorySaved }: {
  transactionId: string;
  categories: CategoryDisplay[];
  onCategorySaved: (category: CategoryDisplay) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [suggestion, setSuggestion] = useState<CategorizationSuggestion | null>(null);
  const [alternative, setAlternative] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [finished, setFinished] = useState(false);
  const displayedAt = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    categorizationTrialAvailable().then(value => { if (mounted.current) setEnabled(value); });
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (suggestion) void markCategorizationSuggestionShown(suggestion.id).catch(() => {
      setError("Unable to record that this suggestion was displayed. You can still review it.");
    });
  }, [suggestion]);

  async function request() {
    setBusy(true); setError("");
    try {
      const value = await requestCategorizationSuggestion(transactionId);
      if (!mounted.current) return;
      setSuggestion(value); displayedAt.current = performance.now();
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : "Unable to get a suggestion");
    } finally { if (mounted.current) setBusy(false); }
  }

  async function review(outcome: "accepted" | "corrected" | "dismissed", categoryId: string | null) {
    if (!suggestion) return;
    setBusy(true); setError("");
    try {
      await reviewCategorizationSuggestion(suggestion.id, outcome, categoryId, performance.now() - displayedAt.current);
      if (!mounted.current) return;
      setFinished(true);
      const category = categories.find(category => category.id === categoryId);
      if (category) onCategorySaved(category);
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : "Unable to save your review");
    } finally { if (mounted.current) setBusy(false); }
  }

  if (!enabled) return null;
  if (finished) return <p role="status" className="text-xs text-muted-foreground">Review recorded.</p>;
  const precedents = suggestion?.evidence.filter(row => row.kind === "verified_precedent") ?? [];
  const counterparts = suggestion?.evidence.filter(row => row.kind === "possible_transfer_counterpart") ?? [];
  const summary = suggestion?.evidence.find(row => row.kind === "evidence_summary");
  return <section aria-label="Category suggestion" className="space-y-3 rounded-md border p-3">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-sm font-medium">Category suggestion</h3>
      {suggestion && <span className="text-xs text-muted-foreground">Needs review</span>}
    </div>
    {!suggestion ? <>
      <p className="text-xs text-muted-foreground">Use your reviewed history to suggest a category.</p>
      <Button type="button" variant="outline" disabled={busy} onClick={request}>
        {busy ? "Finding a suggestion…" : "Suggest category"}
      </Button>
    </> : <>
      <p className="text-sm">{suggestion.category_name ?? "No clear category found"}</p>
      {suggestion.category_type === "transfer" && <p className="text-xs text-muted-foreground">Accepting this category does not link accounts or confirm a transfer.</p>}
      {precedents.length > 0 && <details>
        <summary className="cursor-pointer text-xs">Supporting history ({precedents.length})</summary>
        <ul className="mt-2 space-y-2 text-xs">
          {precedents.map(row => <li key={row.transaction_id} className="break-words">
            <p>{row.description || row.merchant || "Reviewed transaction"} → {row.accepted_category}</p>
            <p className="text-muted-foreground">{row.booked_at?.slice(0, 10)} · {row.amount} {row.currency}{row.account?.name ? ` · ${row.account.name}` : ""}</p>
            {row.rejected_category && <p className="text-muted-foreground">Previously corrected from {row.rejected_category}</p>}
          </li>)}
        </ul>
      </details>}
      {counterparts.length > 0 && <details>
        <summary className="cursor-pointer text-xs">Possible matching transactions ({counterparts.length})</summary>
        <p className="mt-2 text-xs text-muted-foreground">Matching amounts and dates do not prove a transfer.{summary?.counterpart_limit_reached ? " More candidates may exist." : ""}</p>
        <ul className="mt-2 space-y-2 text-xs">{counterparts.map(row => <li key={row.transaction_id} className="break-words">
          {row.booked_at?.slice(0, 10)} · {row.amount} {row.currency} · {row.account?.name || "Another account"} · {row.description || row.merchant}
        </li>)}</ul>
      </details>}
      {precedents.length === 0 && counterparts.length === 0 && <p className="text-xs text-muted-foreground">No relevant reviewed examples or matching transactions were found.</p>}
      {suggestion.category_id && categories.some(category => category.id === suggestion.category_id) && <Button type="button" disabled={busy} onClick={() => review("accepted", suggestion.category_id)}>Accept suggestion</Button>}
      <label className="block space-y-1 text-xs">
        <span>Choose a different category</span>
        <select className="w-full rounded-md border bg-background p-2 text-sm" value={alternative} onChange={event => setAlternative(event.target.value)} disabled={busy}>
          <option value="">Select a category</option>
          {categories.filter(category => category.id !== suggestion.category_id).map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={busy || !alternative} onClick={() => review("corrected", alternative)}>Save correction</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => review("dismissed", null)}>Dismiss</Button>
      </div>
    </>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {error && suggestion && <Button type="button" variant="outline" disabled={busy} onClick={() => { setSuggestion(null); setAlternative(""); setError(""); }}>Start a fresh review</Button>}
    <TrialResults />
  </section>;
}
