import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// Runs a real browser against test/fake-meet.html. Needs CHROME_PATH (skipped otherwise).
const chrome = process.env.CHROME_PATH;
Object.assign(process.env, {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://unused",
  REDIS_URL: process.env.REDIS_URL ?? "redis://unused",
  STORAGE_DIR: process.env.STORAGE_DIR ?? "/tmp",
  BOT_HEADLESS: "true",
});

const fakeMeet = (query: string) =>
  `${pathToFileURL(path.resolve(import.meta.dirname, "../../test/fake-meet.html"))}?${query}`;

describe.skipIf(!chrome || !existsSync(chrome))("recordMeet (fake Meet page)", () => {
  it("joins, records remote audio, posts the consent notice and leaves when alone", async () => {
    const { recordMeet } = await import("./join");
    const chunks: Buffer[] = [];
    const logs: string[] = [];

    const result = await recordMeet({
      url: fakeMeet("callMs=6000"),
      botName: "Notetaker for Test",
      onChunk: async (b64) => void chunks.push(Buffer.from(b64, "base64")),
      leaveBy: new Date(Date.now() + 60_000),
      admitTimeoutMs: 10_000,
      aloneTimeoutMs: 2_000,
      log: (m) => logs.push(m),
    });

    expect(result.reason).toBe("everyone else left");
    const audio = Buffer.concat(chunks);
    // WebM files start with the EBML magic number.
    expect(audio.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
    // ~8s of 64 kbps opus should be well over 10 KB.
    expect(audio.length).toBeGreaterThan(10_000);
    expect(logs.join("\n")).not.toMatch(/consent message/);
  }, 60_000);

  it("reports when the host denies the request", async () => {
    const { recordMeet, JoinFailed } = await import("./join");
    await expect(
      recordMeet({
        url: fakeMeet("deny=1"),
        botName: "Notetaker for Test",
        onChunk: async () => {},
        leaveBy: new Date(Date.now() + 60_000),
        admitTimeoutMs: 10_000,
        log: () => {},
      }),
    ).rejects.toSatisfy((err) => err instanceof JoinFailed && err.reason === "denied");
  }, 60_000);
});
