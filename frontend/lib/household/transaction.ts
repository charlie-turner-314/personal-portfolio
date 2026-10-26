import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export type HouseholdTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const context = new AsyncLocalStorage<HouseholdTransaction>();

/** Nested lifecycle operations share the lock, snapshot and rollback boundary. */
export async function householdTransaction<T>(work: (tx: HouseholdTransaction) => Promise<T>): Promise<T> {
  const current = context.getStore();
  if (current) return work(current);
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(73194, 1)`);
    return context.run(tx, () => work(tx));
  });
}
