/** Reporting equivalence only: never use this to reassign or merge stored categories. */
export function reportingCategoryKey(name: string, type: string): string {
  return JSON.stringify([type, name.trim().toLowerCase()]);
}

export function groupReportingCategories<T extends { id: string; name: string; categoryType?: string | null }>(categories: T[]) {
  const groups = new Map<string, T & { categoryIds: string[] }>();
  for (const category of [...categories].sort((a, b) => a.id.localeCompare(b.id))) {
    // Older callers without a type cannot safely infer equivalence.
    const key = category.categoryType ? reportingCategoryKey(category.name, category.categoryType) : category.id;
    const group = groups.get(key);
    if (group) group.categoryIds.push(category.id);
    else groups.set(key, { ...category, categoryIds: [category.id] });
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}
