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

  it("waits for the owner before asking to join, reports progress, and leaves after the owner does", async () => {
    const { recordMeet } = await import("./join");
    const logs: string[] = [];
    const events: string[] = [];
    const start = Date.now();

    const result = await recordMeet({
      url: fakeMeet("ownerJoinMs=4000&ownerLeaveMs=3000&callMs=60000"),
      botName: "Notetaker for Sharif",
      ownerName: "Sharif Islam",
      ownerGoneMs: 2_000,
      onChunk: async () => {},
      onWaitingRoom: () => void events.push("waiting_room"),
      onAdmitted: () => void events.push("recording"),
      leaveBy: new Date(Date.now() + 60_000),
      admitTimeoutMs: 10_000,
      log: (m) => logs.push(m),
    });

    expect(result.reason).toBe("the owner left");
    expect(events).toEqual(["waiting_room", "recording"]);
    // Joined only after the owner appeared (4s), and left well before the call's 60s end.
    expect(result.joinedAt.getTime() - start).toBeGreaterThanOrEqual(4_000);
    expect(result.leftAt.getTime() - start).toBeLessThan(30_000);
    expect(logs.join("\n")).toMatch(/Sharif Islam is in the call/);
  }, 60_000);

  it("gives up without asking to join when the owner never shows up", async () => {
    const { recordMeet, JoinFailed } = await import("./join");
    const events: string[] = [];
    await expect(
      recordMeet({
        url: fakeMeet("ownerJoinMs=600000"),
        botName: "Notetaker for Sharif",
        ownerName: "Sharif Islam",
        ownerWaitUntil: new Date(Date.now() + 3_000),
        onChunk: async () => {},
        onWaitingRoom: () => void events.push("waiting_room"),
        leaveBy: new Date(Date.now() + 60_000),
        log: () => {},
      }),
    ).rejects.toSatisfy((err) => err instanceof JoinFailed && err.reason === "owner_absent");
    expect(events).toEqual([]);
  }, 60_000);

  it("skips the consent message when chat is restricted", async () => {
    const { recordMeet } = await import("./join");
    const logs: string[] = [];
    await recordMeet({
      url: fakeMeet("chatRestricted=1&callMs=3000"),
      botName: "Notetaker for Sharif",
      onChunk: async () => {},
      leaveBy: new Date(Date.now() + 60_000),
      aloneTimeoutMs: 1_000,
      log: (m) => logs.push(m),
    });
    expect(logs.join("\n")).toMatch(/Chat is restricted/);
    expect(logs.join("\n")).not.toMatch(/Could not post consent message/);
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
