/** Public Play app-signing certificate fingerprints, never upload/debug keys. */
export function parseAndroidAppLinksSha256(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const fingerprints = value.split(",").map(part => part.trim());
  if (fingerprints.some(part => !/^(?:[a-fA-F0-9]{2}:){31}[a-fA-F0-9]{2}$/.test(part))) {
    throw new Error("Invalid ANDROID_APP_LINKS_SHA256. Expected comma-separated SHA-256 certificate fingerprints.");
  }
  return [...new Set(fingerprints.map(part => part.toUpperCase()))];
}
