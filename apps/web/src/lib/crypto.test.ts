import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "./crypto";

const key = randomBytes(32).toString("base64");

describe("token encryption", () => {
  it("round-trips", () => {
    const secret = "ya29.a0AfH6SMB-example-token";
    const enc = encrypt(secret, key);
    expect(enc).not.toContain(secret);
    expect(decrypt(enc, key)).toBe(secret);
  });

  it("uses a fresh IV each time", () => {
    expect(encrypt("same", key)).not.toBe(encrypt("same", key));
  });

  it("rejects tampered ciphertext", () => {
    const parts = encrypt("secret", key).split(":");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decrypt(parts.join(":"), key)).toThrow();
  });

  it("rejects a wrong key", () => {
    const enc = encrypt("secret", key);
    expect(() => decrypt(enc, randomBytes(32).toString("base64"))).toThrow();
  });

  it("rejects a key of the wrong length", () => {
    expect(() => encrypt("x", randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });
});
