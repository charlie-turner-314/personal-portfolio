/** Confidence is an estimate, not a measured probability of correctness. */
export function categoryConfidenceLabel(transaction: {
  categoryId: string | null;
  categorySystemId: string | null;
  categoryConfidence?: number | null;
}): string {
  if (transaction.categoryId) return "Manually categorised";
  if (!transaction.categorySystemId) return "Uncategorised";
  const score = transaction.categoryConfidence;
  if (score == null || !Number.isFinite(score) || score < 0 || score > 100) return "Not scored";
  return `${Math.round(score)}%`;
}
