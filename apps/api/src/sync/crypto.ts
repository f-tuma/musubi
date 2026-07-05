import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { config } from "@musubi/config";

// AES-256-GCM for CalDAV app-passwords at rest. GCM is authenticated — the auth
// tag detects tampering on decrypt. Key = 32 bytes as hex (64 chars) in
// CALDAV_ENC_KEY. Generate one with:  openssl rand -hex 32
function getKey(): Buffer {
  const key = Buffer.from(config.security.caldavEncKey, "hex");
  if (key.length !== 32) {
    throw new Error("CALDAV_ENC_KEY must be 32 bytes as hex (64 hex chars). Generate: openssl rand -hex 32");
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12); // 96-bit IV, GCM standard — fresh per encryption
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(blob: string): string {
  const [ivB64, tagB64, dataB64] = blob.split(":");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return dec.toString("utf8");
}
