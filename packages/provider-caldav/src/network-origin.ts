import type { LookupAddress } from "node:dns";
import { isIP, isIPv4 } from "node:net";
import ipaddr from "ipaddr.js";

export type LookupAll = (
	hostname: string,
	options: { all: true },
) => Promise<LookupAddress[]>;

export function canonicalHttpOrigin(value: string): string | null {
	try {
		const parsed = new URL(value);
		if (
			(parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
			parsed.username ||
			parsed.password ||
			parsed.pathname !== "/" ||
			parsed.search ||
			parsed.hash
		) {
			return null;
		}
		return parsed.origin;
	} catch {
		return null;
	}
}

// ── SSRF guard for the federation gateway ────────────────────────────────────
// The gateway makes this API fetch an origin the user supplied (once, when they
// saved the connection). Without this, a signed-in user could aim their home
// server at internal services or the cloud metadata endpoint.

// [network, prefix length]
const BLOCKED_V4: [string, number][] = [
	["0.0.0.0", 8], // "this host"
	["10.0.0.0", 8], // private
	["100.64.0.0", 10], // CGNAT
	["127.0.0.0", 8], // loopback
	["169.254.0.0", 16], // link-local — cloud metadata lives at 169.254.169.254
	["172.16.0.0", 12], // private
	["192.0.0.0", 24], // IETF protocol assignments
	["192.168.0.0", 16], // private
	["198.18.0.0", 15], // benchmarking
	["224.0.0.0", 4], // multicast
	["240.0.0.0", 4], // reserved
];

function v4ToInt(ip: string): number | null {
	const parts = ip.split(".");
	if (parts.length !== 4) return null;
	let value = 0;
	for (const part of parts) {
		const octet = Number(part);
		if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
		value = value * 256 + octet;
	}
	return value;
}

export function isBlockedAddress(address: string): boolean {
	const ip = address.trim().toLowerCase();

	if (isIPv4(ip)) {
		const value = v4ToInt(ip);
		if (value === null) return true; // unparsable → refuse
		return BLOCKED_V4.some(([network, bits]) => {
			const base = v4ToInt(network)!;
			// >>> 0 keeps the mask unsigned.
			const mask = (~0 << (32 - bits)) >>> 0;
			return (value & mask) === (base & mask);
		});
	}

	// Only IPv6 literals below — a hostname (no colon) is judged by DNS instead,
	// so e.g. "fe80.example.com" isn't mistaken for a link-local address.
	if (!ip.includes(":")) return false;

	try {
		const parsed = ipaddr.parse(ip);
		if (parsed.kind() !== "ipv6") return true;
		const ipv6 = parsed as ipaddr.IPv6;
		if (ipv6.isIPv4MappedAddress()) {
			return isBlockedAddress(ipv6.toIPv4Address().toString());
		}
		return ipv6.range() !== "unicast";
	} catch {
		return true;
	}
}

export async function resolveHttpAddresses(
	origin: string,
	{
		allowPrivate,
		lookupImpl,
	}: {
		allowPrivate: boolean;
		lookupImpl: LookupAll;
	},
): Promise<LookupAddress[]> {
	let host: string;
	try {
		host = new URL(origin).hostname.replace(/^\[|\]$/g, "");
	} catch {
		throw new Error("Invalid HTTP origin.");
	}

	const family = isIP(host);
	const addresses = family
		? [{ address: host, family }]
		: await lookupImpl(host, { all: true }).catch(() => {
				throw new Error(`Could not resolve ${host}.`);
			});

	if (
		addresses.length === 0 ||
		(!allowPrivate &&
			addresses.some(({ address }) => isBlockedAddress(address)))
	) {
		throw new Error(`Refusing to reach the internal address behind ${host}.`);
	}
	return addresses;
}
