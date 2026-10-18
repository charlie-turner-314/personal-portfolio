"use server";

import { revalidatePath } from "next/cache";
import { getAuthenticatedSession } from "@/lib/auth-helpers";
import { createInternalAuthHeaders } from "@/lib/internal-auth";
import { getBackendBaseUrl } from "@/lib/backend-url";
import { isDemoRestrictedUserEmail, DEMO_RESTRICTED_ACTION_ERROR } from "@/lib/demo-access";

export type AiJob = {
  id: string; status: "queued" | "running" | "completed" | "failed";
  total: number; processed: number; categorized: number; skipped: number; error: string | null;
};
export type AiSettings = {
  configured: boolean; automatic: boolean; encryption_available: boolean;
  model: string; uncategorized_count: number; job: AiJob | null;
};
type Result<T> = { success: true; data: T } | { success: false; error: string };

async function request<T>(method: string, suffix = "", body?: object): Promise<Result<T>> {
  const session = await getAuthenticatedSession();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };
  if (isDemoRestrictedUserEmail(session.user.email)) return { success: false, error: DEMO_RESTRICTED_ACTION_ERROR };
  const path = `/api/ai-settings${suffix}`;
  try {
    const response = await fetch(`${getBackendBaseUrl().replace(/\/+$/, "")}${path}`, {
      method, cache: "no-store", signal: AbortSignal.timeout(40_000),
      headers: { "Content-Type": "application/json", ...createInternalAuthHeaders({ method, pathWithQuery: path, userId: session.user.id }) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    if (!response.ok) return { success: false, error: typeof data.detail === "string" ? data.detail : "AI settings request failed. Please try again." };
    return { success: true, data };
  } catch {
    return { success: false, error: "Could not reach AI settings. Please try again." };
  }
}

export async function getAiSettings() {
  const result = await request<AiSettings>("GET");
  if (result.success && ["completed", "failed"].includes(result.data.job?.status ?? "")) {
    revalidatePath("/transactions");
    revalidatePath("/");
  }
  return result;
}
export async function saveAiSettings(apiKey: string, automatic: boolean) {
  return request<{ success: boolean }>("PUT", "", { api_key: apiKey.trim() || null, automatic });
}
export async function testAiConnection(apiKey: string) {
  return request<{ success: boolean }>("POST", "/test", { api_key: apiKey.trim() || null });
}
export async function removeAiKey() { return request<{ success: boolean }>("DELETE"); }
export async function categorizeUncategorized() { return request<{ job: AiJob }>("POST", "/categorize"); }
