/** Equal labels never establish financial equivalence. */
export function reportingCategoryKey(categoryId: string, type: string): string {
  return JSON.stringify([type, categoryId]);
}

/** Explicitly mapped definitions share an ID; unresolved definitions stay distinct. */
export function groupReportingCategories<T extends { id: string; name: string; categoryType?: string | null }>(categories: T[]) {
  const groups = new Map<string, T & { categoryIds: string[] }>();
  for (const category of [...categories].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!groups.has(category.id)) groups.set(category.id, { ...category, categoryIds: [category.id] });
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
