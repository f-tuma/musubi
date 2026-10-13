import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function keyBytes(key: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error("Reference credential key must contain 64 hex digits");
  return Buffer.from(key, "hex");
}
/** Credentials exist only in their own encrypted connection record. */
export function encryptCredential(key: string, connectionId: string, token: string): string {
  if (!token || /[\r\n]/.test(token)) throw new Error("Invalid reference credential");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  cipher.setAAD(Buffer.from(connectionId));
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString("base64")).join(".");
}
export function decryptCredential(key: string, connectionId: string, value: string): string {
  const parts = value.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted reference credential");
  const [iv, tag, encrypted] = parts.map(part => Buffer.from(part, "base64"));
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid encrypted reference credential");
  const cipher = createDecipheriv("aes-256-gcm", keyBytes(key), iv);
  cipher.setAAD(Buffer.from(connectionId)); cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString("utf8");
}
export function assertCredentialKey(key: string): void { keyBytes(key); }
