/**
 * Column names are unique per board under this key: trimmed, internal runs of whitespace collapsed,
 * case-insensitive. Board-wide lookups by name (resolveColumn) compare with it too.
 */
export const columnNameKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

/** The names whose key already appeared earlier in `names`, in file order (the raw names as given). */
export function duplicateColumnNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const name of names) {
    const key = columnNameKey(name);
    if (seen.has(key)) duplicates.push(name);
    else seen.add(key);
  }
  return duplicates;
}

/** Error message naming the repeated columns, or null when none repeat. */
export function duplicateColumnNamesMessage(names: readonly string[]): string | null {
  const duplicates = duplicateColumnNames(names);
  return duplicates.length > 0 ? `Duplicate column names: ${duplicates.map((n) => `"${n}"`).join(", ")}` : null;
}
