/** Preserve the native opaque strong ETag verbatim, including comma/backslash. */
export function strongCaldavEtag(value: unknown): string | null {
  return typeof value === "string" && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value) ? value : null;
}
