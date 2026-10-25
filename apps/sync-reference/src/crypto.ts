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

export interface ReferenceBasicCredential { kind: "basic"; username: string; password: string }
/** Provider-specific plaintext shape exists only inside the credential port. */
export function basicCredential(value: unknown): ReferenceBasicCredential {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== 3 || !["kind", "username", "password"].every(key => Object.hasOwn(value, key))) throw new Error("Invalid reference Basic credential");
  const fields = Object.fromEntries(["kind", "username", "password"].map(key => {
    const field = Object.getOwnPropertyDescriptor(value, key); if (!field || !("value" in field)) throw new Error("Invalid reference Basic credential");
    return [key, field.value];
  }));
  if (fields.kind !== "basic" || ![fields.username, fields.password].every(text => typeof text === "string" && text.length > 0 && text.length <= 8192 && !/[\x00-\x1f\x7f]/.test(text)) || fields.username.includes(":"))
    throw new Error("Invalid reference Basic credential");
  return { kind: "basic", username: fields.username, password: fields.password };
}
