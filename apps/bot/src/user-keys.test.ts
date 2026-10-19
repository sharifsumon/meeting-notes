import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

Object.assign(process.env, {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://unused",
  REDIS_URL: process.env.REDIS_URL ?? "redis://unused",
  STORAGE_DIR: process.env.STORAGE_DIR ?? "/tmp",
  CHROME_PATH: process.env.CHROME_PATH ?? "/unused",
});

// The same format apps/web/src/lib/crypto.ts writes.
function encrypt(plaintext: string, keyB64: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyB64, "base64"), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(":");
}

describe("decrypt", () => {
  it("reads keys the web app encrypted, and rejects the wrong key", async () => {
    const { decrypt } = await import("./user-keys");
    const key = randomBytes(32).toString("base64");
    expect(decrypt(encrypt("AIza-user-key", key), key)).toBe("AIza-user-key");
    expect(() => decrypt(encrypt("AIza-user-key", key), randomBytes(32).toString("base64"))).toThrow();
  });
});
