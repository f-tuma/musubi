export function normalizeServerUrl(value: string) {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("Enter a valid server URL.");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("Server URL must use HTTP or HTTPS.");
	}
	return url.origin.toLowerCase();
}

export function serverStoragePrefix(value: string) {
	const origin = normalizeServerUrl(value);
	// SecureStore keys permit letters, digits, dots, hyphens and underscores.
	// Escape the full origin, including scheme, and escape underscores too so
	// host punctuation cannot alias another server. Never fall back to the old
	// lossy keys: they do not establish which origin owns the stored credential.
	return `musubi_v2_${origin.replace(/[^a-z0-9.-]/g, character => `_${character.charCodeAt(0).toString(16)}`)}`;
}
