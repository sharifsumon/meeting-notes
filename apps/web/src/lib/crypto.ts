import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM. Ciphertext format: "v1:<iv>:<tag>:<data>", each part base64url.
const PREFIX = "v1";

function parseKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return key;
}

export function encrypt(plaintext: string, keyB64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", parseKey(keyB64), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv, tag, data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(":");
}

export function decrypt(ciphertext: string, keyB64: string): string {
  const [prefix, iv, tag, data] = ciphertext.split(":");
  if (prefix !== PREFIX || !iv || !tag || data === undefined) throw new Error("Unrecognized ciphertext format");
  const decipher = createDecipheriv("aes-256-gcm", parseKey(keyB64), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}
