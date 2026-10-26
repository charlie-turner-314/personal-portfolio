"use client";
import { Button } from "@/components/ui/button";
import type { HouseholdTransitionPreview } from "@/lib/household/transitions";

export type TransitionReviewData = { preview: HouseholdTransitionPreview; confirmation: string };

export function TransitionReview({ review, busy, onConfirm, onCancel, memberName }: {
  review: TransitionReviewData; busy: boolean; onConfirm: () => void; onCancel: () => void;
  memberName?: (id: string) => string;
}) {
  const plan = review.preview;
  return <section aria-label="Review household transition" className="space-y-4 rounded border p-4">
    <h4 className="font-medium">Review access changes</h4>
    <p>{plan.accountPolicy}</p>
    {plan.action === "share-account" && <p>Selected recipients: {plan.recipients.length
      ? plan.recipients.map(id => memberName?.(id) ?? "Household member").join(", ") : "Nobody — only the custodian retains access"}.</p>}
    {!!plan.revokedRecipients.length && <p>Access is withdrawn from: {plan.revokedRecipients.map(id => memberName?.(id) ?? "Household member").join(", ")}.</p>}
    {!plan.accounts.length && <p>No accounts visible to you change access in this transition. Other members’ private accounts stay private.</p>}
    {plan.accounts.map(account => <div key={account.id} className="space-y-1 border-t pt-2">
      <p className="font-medium">{account.name} · {account.currency}</p>
      <p>{account.change}</p>
      <p>{account.recordCount} recorded transactions. History starts {account.firstRecord
        ? account.firstRecord.slice(0, 10) : "when the first record is imported"}; all recorded history and future records are included in a grant.</p>
    </div>)}
    {!!plan.properties.length && <p>Property grants are revoked for: {plan.properties.map(property => property.name).join(", ")}. Property custody and ownership remain unchanged.</p>}
    {plan.aggregateSharingEnds && <p>Your affected net-worth aggregate sharing ends; private totals are not included in this preview.</p>}
    <details><summary>Category mappings and conflicts</summary>
      <p>Classification IDs are retained. Same-name definitions remain separate until you explicitly resolve their meanings. Private guidance is excluded.</p>
      <ul className="max-h-48 list-disc overflow-auto pl-5">{plan.categoryMappings.map(category => <li key={category.id}>
        {category.name} · {category.categoryType ?? "unclassified"}{category.cashFlowKind ? ` · ${category.cashFlowKind}` : ""}
        {plan.categoryConflicts.some(conflict => conflict.id === category.id) ? " · name conflict retained" : ""}
      </li>)}</ul>
    </details>
    <ul className="list-disc space-y-1 pl-5 text-sm">{plan.effects.map(effect => <li key={effect}>{effect}</li>)}</ul>
    <div className="flex gap-3"><Button disabled={busy} onClick={onConfirm}>Confirm access changes</Button>
      <Button variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button></div>
  </section>;
}
