import { createDecipheriv } from "node:crypto";
import { config } from "./config";

/** Decrypts a value the web app stored with AES-256-GCM ("v1:<iv>:<tag>:<data>", see apps/web/src/lib/crypto.ts). */
export function decrypt(ciphertext: string, keyB64: string): string {
  const [prefix, iv, tag, data] = ciphertext.split(":");
  if (prefix !== "v1" || !iv || !tag || data === undefined) throw new Error("Unrecognized ciphertext format");
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

/** The meeting owner's own Gemini key, or undefined to use the server's. */
export function ownGeminiKey(stored: string | null | undefined): string | undefined {
  if (!stored) return undefined;
  if (!config.TOKEN_ENCRYPTION_KEY) {
    console.error("[keys] A user saved a Gemini key but TOKEN_ENCRYPTION_KEY isn't set; using the server's key");
    return undefined;
  }
  try {
    return decrypt(stored, config.TOKEN_ENCRYPTION_KEY);
  } catch (err) {
    console.error(`[keys] Couldn't read a user's Gemini key, using the server's: ${err}`);
    return undefined;
  }
}
