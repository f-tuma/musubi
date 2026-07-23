export function canonicalHttpOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}
