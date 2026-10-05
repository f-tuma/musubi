import assert from "node:assert/strict";
import { normalizeServerUrl, serverStoragePrefix } from "./serverUrl";

assert.equal(normalizeServerUrl(" HTTPS://Dev.Musubi.Pro/path/ "), "https://dev.musubi.pro");
assert.equal(serverStoragePrefix("https://dev.musubi.pro"), serverStoragePrefix(" HTTPS://Dev.Musubi.Pro/path/ "));
const distinctOrigins = [
	"https://api.example.com", "https://api-example.com", "http://api.example.com",
	"https://api.example.com:7531", "https://api_example.com", "https://[::1]:7531",
];
assert.equal(new Set(distinctOrigins.map(serverStoragePrefix)).size, distinctOrigins.length,
	"Distinct schemes, host punctuation and ports never share an auth namespace");
for (const origin of distinctOrigins) {
	assert.match(serverStoragePrefix(origin), /^[a-z0-9_.-]+$/i, "Namespace is a valid SecureStore key");
	assert.match(serverStoragePrefix(origin), /^musubi_v2_/, "Ambiguous legacy keys are never reused");
}
assert.notEqual(
	serverStoragePrefix("https://dev.musubi.pro"),
	serverStoragePrefix("https://musubi.pro"),
);
assert.throws(() => normalizeServerUrl("ftp://musubi.pro"), /HTTP/);

console.log("server URL self-check: OK");
