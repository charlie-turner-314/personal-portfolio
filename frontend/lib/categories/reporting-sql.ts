import { sql, type SQLWrapper } from "drizzle-orm";

/** Caller must separately apply account access to the transaction being filtered. */
export function reportingCategoryFilter(categoryId: SQLWrapper, selectedIds: string[]) {
  if (!selectedIds.length) return sql`false`;
  return sql`${categoryId} IN (
    SELECT equivalent.id FROM categories equivalent
    JOIN categories selected ON equivalent.category_type = selected.category_type
      AND LOWER(BTRIM(equivalent.name)) = LOWER(BTRIM(selected.name))
    WHERE selected.id IN (${sql.join(selectedIds.map(id => sql`${id}`), sql`, `)})
  )`;
}
