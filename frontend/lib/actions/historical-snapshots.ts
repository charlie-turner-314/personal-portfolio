"use server";

import { and, asc, eq, gte, lte } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { historicalSnapshotImports, historicalSnapshotValues } from "@/lib/db/schema";
import { getAuthenticatedSession } from "@/lib/auth-helpers";
import { isDemoRestrictedUserEmail, DEMO_RESTRICTED_ACTION_ERROR } from "@/lib/demo-access";

export type HistoricalSnapshotRow = { date: string; netWorth: number | null; metrics?: Record<string, number> };

export async function importHistoricalSnapshots(
  fileName: string,
  rows: HistoricalSnapshotRow[],
  duplicateMode: "skip" | "replace",
) {
  const session = await getAuthenticatedSession();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };
  if (isDemoRestrictedUserEmail(session.user.email)) return { success: false, error: DEMO_RESTRICTED_ACTION_ERROR };
  const validRows = rows.filter((row) => row.netWorth !== null && /^\d{4}-\d{2}-\d{2}$/.test(row.date));
  if (!validRows.length) return { success: false, error: "Map a date and net-worth value with at least one valid row." };
  const importResult = await db.insert(historicalSnapshotImports).values({ userId: session.user.id, fileName }).returning({ id: historicalSnapshotImports.id });
  let imported = 0;
  let skipped = 0;
  for (const row of validRows) {
    const existing = await db.query.historicalSnapshotValues.findFirst({ where: and(eq(historicalSnapshotValues.userId, session.user.id), eq(historicalSnapshotValues.snapshotDate, row.date)) });
    if (existing && duplicateMode === "skip") { skipped += 1; continue; }
    if (existing) {
      await db.update(historicalSnapshotValues).set({ netWorth: String(row.netWorth), metricValues: row.metrics || {}, importId: importResult[0].id }).where(eq(historicalSnapshotValues.id, existing.id));
    } else {
      await db.insert(historicalSnapshotValues).values({ userId: session.user.id, importId: importResult[0].id, snapshotDate: row.date, netWorth: String(row.netWorth), metricValues: row.metrics || {} });
    }
    imported += 1;
  }
  revalidatePath("/"); revalidatePath("/settings");
  return { success: true, imported, skipped };
}

export async function getHistoricalSnapshotHistory(startDate: Date, endDate: Date) {
  const session = await getAuthenticatedSession();
  if (!session?.user?.id) return [];
  const rows = await db.select({ date: historicalSnapshotValues.snapshotDate, value: historicalSnapshotValues.netWorth })
    .from(historicalSnapshotValues)
    .where(and(eq(historicalSnapshotValues.userId, session.user.id), gte(historicalSnapshotValues.snapshotDate, startDate.toISOString().slice(0, 10)), lte(historicalSnapshotValues.snapshotDate, endDate.toISOString().slice(0, 10))))
    .orderBy(asc(historicalSnapshotValues.snapshotDate));
  return rows.map((row) => ({ date: row.date, value: Number(row.value) }));
}
