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

describe("titleFromTabTitle", () => {
  it("keeps a real name and drops Meet's own words and bare codes", async () => {
    const { titleFromTabTitle } = await import("./join");
    expect(titleFromTabTitle("Meet - Weekly sync")).toBe("Weekly sync");
    expect(titleFromTabTitle("Weekly sync – Google Meet")).toBe("Weekly sync");
    expect(titleFromTabTitle("Meet – ofw-zegm-ueq")).toBeNull();
    expect(titleFromTabTitle("Google Meet")).toBeNull();
    expect(titleFromTabTitle("")).toBeNull();
  });
});

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
      levelLogMs: 2_000,
      log: (m) => logs.push(m),
    });

    expect(result.reason).toBe("everyone else left");
    // The fake call plays a tone, so the bot should hear it.
    expect(logs.join("\n")).toMatch(/Audio level: peak -?\d+ dBFS/);
    expect(logs.join("\n")).not.toMatch(/Only hearing silence/);
    const audio = Buffer.concat(chunks);
    // WebM files start with the EBML magic number.
    expect(audio.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
    // ~8s of 64 kbps opus should be well over 10 KB.
    expect(audio.length).toBeGreaterThan(10_000);
    expect(logs.join("\n")).not.toMatch(/consent message/);
  }, 60_000);

  it("asks to join right away, reports progress, and leaves after the owner does", async () => {
    const { recordMeet } = await import("./join");
    const logs: string[] = [];
    const events: string[] = [];
    const start = Date.now();

    // hideLobbyPeople: like Meet for accounts outside the host's organization.
    const result = await recordMeet({
      url: fakeMeet("hideLobbyPeople=1&ownerJoinMs=12000&ownerLeaveMs=14000&callMs=60000"),
      botName: "Notetaker for Sharif",
      ownerNames: ["Sharif Sumon", "Sharif Islam"],
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
    // Joined before the owner appeared (12s), and left well before the call's 60s end.
    expect(result.joinedAt.getTime() - start).toBeLessThan(12_000);
    expect(result.leftAt.getTime() - start).toBeLessThan(40_000);
  }, 60_000);

  it("keeps recording when the owner never shows up but others are talking", async () => {
    const { recordMeet } = await import("./join");
    const result = await recordMeet({
      url: fakeMeet("ownerJoinMs=600000&guests=1&callMs=5000"),
      botName: "Notetaker for Sharif",
      ownerNames: ["Sharif Islam"],
      ownerGoneMs: 1_000,
      onChunk: async () => {},
      leaveBy: new Date(Date.now() + 60_000),
      aloneTimeoutMs: 1_000,
      log: () => {},
    });
    expect(result.reason).toBe("everyone else left");
  }, 60_000);

  it("notes who the captions show speaking, the participants and the call's name", async () => {
    const { recordMeet } = await import("./join");
    const titles: string[] = [];
    const result = await recordMeet({
      url: fakeMeet("captions=1&title=Weekly%20sync&callMs=8000"),
      botName: "Notetaker for Sharif",
      onChunk: async () => {},
      onTitle: (t) => void titles.push(t),
      leaveBy: new Date(Date.now() + 60_000),
      aloneTimeoutMs: 1_000,
      log: () => {},
    });
    expect(titles).toEqual(["Weekly sync"]);
    expect(result.participants).toEqual(["Sharif Islam", "Guest Two"]);
    const [first, second] = result.speakerTimeline;
    expect(result.speakerTimeline.map((t) => t.name)).toEqual(["Sharif Islam", "Guest Two"]);
    // Sharif speaks first, then Guest Two about three seconds later (polling blurs this by up to a second).
    expect(first!.endMs).toBeGreaterThan(first!.startMs);
    expect(second!.startMs - first!.startMs).toBeGreaterThan(1_000);
  }, 60_000);

  it("waits for slow captions instead of toggling them off again, and leaves itself out of the people", async () => {
    const { recordMeet } = await import("./join");
    const result = await recordMeet({
      url: fakeMeet("captions=1&ccDelayMs=5000&callMs=14000&botListedAs=Minute%20Flow"),
      botName: "Notetaker for Sharif",
      onChunk: async () => {},
      leaveBy: new Date(Date.now() + 60_000),
      aloneTimeoutMs: 1_000,
      log: () => {},
    });
    expect(result.participants).toEqual(["Sharif Islam", "Guest Two"]);
    expect(result.speakerTimeline.map((t) => t.name)).toEqual(["Sharif Islam", "Guest Two"]);
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

  it("doesn't count the waiting room as being in the call", async () => {
    const { recordMeet } = await import("./join");
    const times: Record<string, number> = {};
    await recordMeet({
      url: fakeMeet("waitingRoomLeave=1&admitMs=5000&callMs=2000"),
      botName: "Notetaker for Test",
      onChunk: async () => {},
      onWaitingRoom: () => void (times.asked = Date.now()),
      onAdmitted: () => void (times.admitted = Date.now()),
      leaveBy: new Date(Date.now() + 60_000),
      admitTimeoutMs: 20_000,
      aloneTimeoutMs: 1_000,
      log: () => {},
    });
    expect(times.admitted! - times.asked!).toBeGreaterThanOrEqual(4_500);
  }, 60_000);

  it("ends cleanly with the audio so far when the browsers are closed (a restart)", async () => {
    const { recordMeet, closeAllBrowsers } = await import("./join");
    const chunks: Buffer[] = [];
    const running = recordMeet({
      url: fakeMeet("callMs=60000"),
      botName: "Notetaker for Test",
      onChunk: async (b64) => void chunks.push(Buffer.from(b64, "base64")),
      onAdmitted: () => void setTimeout(() => void closeAllBrowsers(), 7_000),
      leaveBy: new Date(Date.now() + 60_000),
      log: () => {},
    });
    const result = await running;
    expect(result.reason).toMatch(/page closed|no longer in the call/);
    expect(Buffer.concat(chunks).length).toBeGreaterThan(5_000);
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

describe("isBotName", () => {
  it("matches the bot however Meet labels it", async () => {
    const { isBotName } = await import("./names");
    const bot = ["Notetaker for Sharif", "Minute Flow"];
    expect(isBotName("Minute Flow", bot)).toBe(true);
    expect(isBotName("MinuteFlow (You)", bot)).toBe(true);
    expect(isBotName("minute  flow", bot)).toBe(true);
    expect(isBotName("Notetaker for Sharif", bot)).toBe(true);
    expect(isBotName("Mohammed Shariful Islam", bot)).toBe(false);
  });
});
