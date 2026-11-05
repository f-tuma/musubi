/** OAuth grants are case-sensitive token sets. Preserve the stored spelling
 * when refresh only changes ordering/separators, so its grant generation and
 * in-flight provider authority remain valid. Unknown and known-empty differ. */
export function refreshedOAuthScope(previous: string | null, next: string | undefined): string | undefined {
  if (next === undefined) return undefined;
  if (previous !== null) {
    const before = new Set(previous.split(/[\s,]+/).filter(Boolean));
    const after = new Set(next.split(/[\s,]+/).filter(Boolean));
    if (before.size === after.size && [...before].every(scope => after.has(scope))) return undefined;
  }
  return next;
}
