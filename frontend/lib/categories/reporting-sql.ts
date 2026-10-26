import { sql, type SQLWrapper } from "drizzle-orm";

/** Caller must separately apply account access. Select only explicit IDs. */
export function reportingCategoryFilter(categoryId: SQLWrapper, selectedIds: string[]) {
  if (!selectedIds.length) return sql`false`;
  return sql`${categoryId} IN (${sql.join([...new Set(selectedIds)].map(id => sql`${id}`), sql`, `)})`;
}
