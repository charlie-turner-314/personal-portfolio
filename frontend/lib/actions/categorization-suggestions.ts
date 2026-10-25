"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth-helpers";
import { getBackendBaseUrl } from "@/lib/backend-url";
import { createInternalAuthHeaders } from "@/lib/internal-auth";

export interface CategorizationEvidence {
  kind: string;
  transaction_id?: string;
  description?: string;
  merchant?: string;
  amount?: string;
  currency?: string;
  booked_at?: string;
  accepted_category?: string;
  rejected_category?: string;
  account?: { name?: string };
  counterparts_selected?: number;
  counterparts_shown?: number;
  counterpart_limit_reached?: boolean;
}

export interface CategorizationSuggestion {
  id: string;
  transaction_id: string;
  category_id: string | null;
  category_name: string | null;
  category_type: string | null;
  status: "needs_review" | "reviewed";
  evidence: CategorizationEvidence[];
  review_outcome: string | null;
}

async function callBackend(path: string, method = "GET", body?: unknown) {
  const userId = await requireAuth();
  if (!userId) throw new Error("Not authenticated");
  const pathWithQuery = `/api/categorization-suggestions${path}`;
  const response = await fetch(`${getBackendBaseUrl()}${pathWithQuery}`, {
    method,
    headers: { ...createInternalAuthHeaders({ method, pathWithQuery, userId }), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(240_000),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(typeof error.detail === "string" ? error.detail : "Categorisation request failed");
  }
  return response.json();
}

export async function categorizationTrialAvailable(): Promise<boolean> {
  try {
    return (await callBackend("/availability")).enabled === true;
  } catch {
    return false;
  }
}

export async function requestCategorizationSuggestion(transactionId: string): Promise<CategorizationSuggestion> {
  return callBackend(`/transactions/${encodeURIComponent(transactionId)}`, "POST");
}

export async function reviewCategorizationSuggestion(
  suggestionId: string,
  outcome: "accepted" | "corrected" | "dismissed",
  categoryId: string | null,
  reviewDurationMs: number,
): Promise<CategorizationSuggestion> {
  const result = await callBackend(`/${encodeURIComponent(suggestionId)}/review`, "POST", {
    outcome, category_id: categoryId, review_duration_ms: Math.min(3_600_000, Math.max(0, Math.round(reviewDurationMs))),
  });
  revalidatePath("/transactions");
  return result;
}

export async function getCategorizationTrialSummary(): Promise<{
  requested: number;
  outcomes: Record<string, number>;
  acceptance_among_category_reviews: number | null;
  mean_review_duration_ms: number | null;
  duration_note: string;
}> {
  return callBackend("/summary");
}
