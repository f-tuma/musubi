/** RFC 9110 strong entity-tag comparison, without repairing a native value. */
export function strongGoogleEtag(value: unknown): string | null {
  return typeof value === "string" && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value) ? value : null;
}
