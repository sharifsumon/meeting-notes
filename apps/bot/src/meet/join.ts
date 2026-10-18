import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { config, headless } from "../config";
import { installAudioCapture, installCaptionWatcher } from "./capture";
import { dedupeNames, isBotName } from "./names";

export class JoinFailed extends Error {
  constructor(
    message: string,
    readonly reason: "denied" | "timeout" | "blocked" | "error",
  ) {
    super(message);
    this.name = "JoinFailed";
  }
}

export type MeetSessionOptions = {
  url: string;
  botName: string;
  /** Called with each recorded audio chunk (base64 webm/opus). */
  onChunk: (b64: string) => Promise<void>;
  /** Hard stop: leave at this time even if people are still talking. */
  leaveBy: Date;
  /** How long to wait in the lobby for the host to admit the bot. */
  admitTimeoutMs?: number;
  /** Checked while waiting in the lobby; true means stop waiting so another call can have this bot. */
  giveWay?: () => Promise<boolean>;
  /** Leave after being the only participant this long. */
  aloneTimeoutMs?: number;
  /**
   * Display names of the MinuteFlow users this call belongs to (one event can be on several
   * people's calendars). The bot leaves `ownerGoneMs` after the last of them leaves the call. It still asks to join right away: Meet hides who's in a call from accounts
   * outside the host's organization, so the lobby can't tell whether the owner is there.
   */
  ownerNames?: string[];
  ownerGoneMs?: number;
  /** How often to log the audio level (and warn about silence). */
  levelLogMs?: number;
  /** Progress callbacks, used to update the bot session's status. */
  onWaitingRoom?: () => PromiseLike<unknown> | void;
  onAdmitted?: (joinedAt: Date) => PromiseLike<unknown> | void;
  /** Called once in the call with the call's name, when Meet shows one. */
  onTitle?: (title: string) => PromiseLike<unknown> | void;
  log?: (msg: string) => void;
};

/**
 * A black picture and silence for Chrome's fake camera and microphone. Its defaults are a moving
 * test pattern and a beep, which people would see and hear if Meet ever turned them back on.
 */
async function blankMediaArgs(): Promise<string[]> {
  const dir = path.join(tmpdir(), "minuteflow-media");
  const video = path.join(dir, "black.y4m");
  const audio = path.join(dir, "silence.wav");
  await mkdir(dir, { recursive: true });
  const [w, h] = [320, 240];
  const frame = Buffer.concat([Buffer.from("FRAME\n"), Buffer.alloc(w * h, 16), Buffer.alloc((w * h) / 2, 128)]);
  await writeFile(video, Buffer.concat([Buffer.from(`YUV4MPEG2 W${w} H${h} F1:1 Ip A1:1 C420jpeg\n`), frame]));
  const samples = 16_000; // one second, 16-bit mono at 16 kHz; Chrome loops it
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  await writeFile(audio, wav);
  return [`--use-file-for-fake-video-capture=${video}`, `--use-file-for-fake-audio-capture=${audio}`];
}

const BROWSER_ARGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  "--disable-blink-features=AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
  "--lang=en-US",
  // Several bots share one virtual screen; a window behind another must keep running at full speed.
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
];

// Chrome locks a profile to one browser, so only one bot at a time uses the signed-in profile itself.
let profileInUse = false;

// Caches, lock files and Chrome's scratch files aren't needed to stay signed in.
const SKIP_IN_COPY =
  /^(Singleton\w*|lockfile|LOCK|BrowserMetrics.*|.*\.pma|Cache|Code Cache|GPUCache|GrShaderCache|ShaderCache|DawnCache|Crashpad|component_crx_cache)$/;

/**
 * Copies the signed-in profile for a bot that runs while another bot holds the original. That
 * Chrome keeps creating and deleting files, so a file that vanishes mid-copy is skipped.
 */
export async function copyProfile(from: string, to: string) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true }).catch(() => [])) {
    if (SKIP_IN_COPY.test(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    try {
      if (entry.isDirectory()) await copyProfile(src, dest);
      else if (entry.isFile()) await copyFile(src, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

/**
 * Opens a browser context: the signed-in bot profile when BOT_PROFILE_DIR is set, otherwise a fresh
 * guest. A bot that starts while another holds the profile signs in from a copy of it, deleted when
 * its browser closes; the original stays the one Google keeps refreshing.
 */
export async function launchContext(): Promise<BrowserContext> {
  const options = { permissions: ["microphone", "camera"], locale: "en-US" };
  if (config.BOT_PROFILE_DIR) {
    const original = !profileInUse;
    profileInUse ||= original;
    const dir = original ? config.BOT_PROFILE_DIR : `${config.BOT_PROFILE_DIR}-copies/${randomUUID()}`;
    const release = async () => {
      if (original) profileInUse = false;
      // Chrome can still be writing to the copy as it exits.
      else await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
    };
    try {
      if (!original) await copyProfile(config.BOT_PROFILE_DIR, dir);
      const context = await chromium.launchPersistentContext(dir, {
        ...options,
        executablePath: config.CHROME_PATH,
        headless,
        args: [...BROWSER_ARGS, ...(await blankMediaArgs())],
      });
      context.on("close", () => void release());
      return context;
    } catch (err) {
      await release();
      throw err;
    }
  }
  const browser = await chromium.launch({
    executablePath: config.CHROME_PATH,
    headless,
    args: [...BROWSER_ARGS, ...(await blankMediaArgs())],
  });
  const context = await browser.newContext(options);
  context.on("close", () => void browser.close().catch(() => {}));
  return context;
}

/** Adds the hooks a page needs before it loads. Shared with tests. */
export async function preparePage(page: Page, onChunk: (b64: string) => Promise<void>) {
  await page.exposeFunction("__mfChunk", onChunk);
  // tsx/esbuild may wrap functions in a `__name` helper that doesn't exist in the page.
  await page.addInitScript("window.__name = window.__name || ((f) => f);");
  await page.addInitScript(installAudioCapture);
}

export function withEnglishUi(url: string) {
  const u = new URL(url);
  u.searchParams.set("hl", "en");
  return u.toString();
}

/**
 * Joins a Google Meet call as a guest, records until the meeting ends (or the bot is
 * alone, removed, or hits leaveBy), then leaves. Resolves when the bot has left.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const open = new Set<BrowserContext>();

/** Closes every bot browser, so running sessions end now and save what they recorded. */
export async function closeAllBrowsers() {
  await Promise.all([...open].map((c) => c.close().catch(() => {})));
}

export type MeetRecording = {
  joinedAt: Date;
  leftAt: Date;
  reason: string;
  /** The call's name as Meet shows it, when it has one beyond the meeting code. */
  title: string | null;
  /** Names seen in the People list, without the bot. */
  participants: string[];
  /** Who the captions showed speaking, in ms from the start of the recording. */
  speakerTimeline: SpeakerTurn[];
};

export type SpeakerTurn = { name: string; startMs: number; endMs: number };

export async function recordMeet(opts: MeetSessionOptions): Promise<MeetRecording> {
  const log = opts.log ?? console.log;
  const context = await launchContext();
  open.add(context);
  try {
    const page = await context.newPage();
    await preparePage(page, opts.onChunk);

    log(`Opening ${opts.url}`);
    await page.goto(withEnglishUi(opts.url), { waitUntil: "domcontentloaded" });

    const names = (opts.ownerNames ?? []).filter((n) => n.trim());
    const owner = names.length ? ownersPattern(names) : null;
    await prepareLobby(page);

    await joinFromLobby(page, opts.botName, opts.admitTimeoutMs ?? 5 * 60_000, log, opts.onWaitingRoom, opts.giveWay);
    const joinedAt = new Date();
    log("In the meeting; recording");

    await page.evaluate(() => (window as unknown as { __mfStart: () => void }).__mfStart());
    const levelTimer = setInterval(() => void logLevel(page, log), opts.levelLogMs ?? 60_000);
    await Promise.resolve(opts.onAdmitted?.(joinedAt)).catch((err) => log(`Status update failed: ${err}`));
    // The lobby's camera and mic switches don't always stick; the bot shows no picture and makes no sound.
    for (const name of [/turn off camera/i, /turn off microphone/i]) {
      const button = page.getByRole("button", { name }).first();
      if (await button.isVisible().catch(() => false)) await button.click({ timeout: 2_000 }).catch(() => {});
    }
    await announce(page, opts.botName, log).catch((err) => log(`Could not post consent message: ${err}`));
    await enableCaptions(page, log).catch((err) => log(`Could not turn on captions: ${err}`));
    const title = await meetingTitle(page);
    if (title) await Promise.resolve(opts.onTitle?.(title)).catch((err) => log(`Title update failed: ${err}`));
    const seen = new Set<string>();

    const reason = await waitForEnd(page, {
      leaveBy: opts.leaveBy,
      aloneTimeoutMs: opts.aloneTimeoutMs ?? 60_000,
      owner,
      ownerGoneMs: opts.ownerGoneMs ?? 30_000,
      seen,
      log,
    });
    log(`Leaving: ${reason}`);
    clearInterval(levelTimer);
    const speakerTimeline = await page
      .evaluate(() => (window as unknown as { __mfSpeakers?: () => SpeakerTurn[] }).__mfSpeakers?.() ?? [])
      .catch(() => []);
    log(`Captions named ${new Set(speakerTimeline.map((t) => t.name)).size} speakers in ${speakerTimeline.length} turns`);
    if (!speakerTimeline.length) {
      const stats = await page
        .evaluate(() => (window as unknown as { __mfCaptionStats?: () => unknown }).__mfCaptionStats?.())
        .catch(() => null);
      log(`Caption area: ${JSON.stringify(stats)}`);
    }

    await page
      .evaluate(() => (window as unknown as { __mfStop: () => Promise<void> }).__mfStop())
      .catch((err) => log(`Stopping recorder failed: ${err}`));
    await page.getByRole("button", { name: /leave call/i }).click({ timeout: 5_000 }).catch(() => {});
    // Signed in, Meet shows the bot under its Google account's name rather than the name it asked to join with.
    const botNames = [opts.botName, config.BOT_ACCOUNT_NAME];
    const participants = dedupeNames([...seen].filter((n) => !isBotName(n, botNames)));
    return {
      joinedAt,
      leftAt: new Date(),
      reason,
      title,
      participants,
      speakerTimeline: speakerTimeline.filter((t) => !isBotName(t.name, botNames)),
    };
  } finally {
    open.delete(context);
    await context.close().catch(() => {});
  }
}

const dbfs = (v: number) => (v > 0 ? `${(20 * Math.log10(v)).toFixed(0)} dBFS` : "silent");

/** Logs what the recorder heard since the last check, so silent recordings can be diagnosed. */
async function logLevel(page: Page, log: (m: string) => void) {
  const level = await page
    .evaluate(() => (window as unknown as { __mfLevel: () => { peak: number; rms: number; tracks: number; liveTracks: number } }).__mfLevel())
    .catch(() => null);
  if (!level) return;
  log(`Audio level: peak ${dbfs(level.peak)}, average ${dbfs(level.rms)}; ${level.liveTracks} of ${level.tracks} audio tracks live`);
  // About -60 dBFS: nothing but silence (or the odd click) since the last check.
  if (level.peak < 0.001) log(`Only hearing silence (${level.tracks} audio tracks)`);
}

const BLOCKED_MESSAGE = config.BOT_PROFILE_DIR
  ? "Google Meet refused to let the bot in"
  : "Google Meet refused to let the bot in as a signed-out guest (sign the bot in: see README)";

const BLOCKED_TEXT = /you can't join this video call|unable to join this call/i;

/** Dismisses "Got it" style dialogs, then turns mic and camera off. */
async function prepareLobby(page: Page) {
  await page.getByRole("button", { name: /^got it$/i }).click({ timeout: 5_000 }).catch(() => {});
  for (const name of [/turn off microphone/i, /turn off camera/i]) {
    await page.getByRole("button", { name }).first().click({ timeout: 10_000 }).catch(() => {});
  }
}

/** Labels of the buttons on screen, for logs when the bot can't find what it needs. */
async function visibleButtons(page: Page): Promise<string[]> {
  return page
    .getByRole("button")
    .evaluateAll((els) =>
      els
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => el.getAttribute("aria-label") || (el as HTMLElement).innerText)
        .filter(Boolean)
        .slice(0, 40),
    )
    .catch(() => []);
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches any of the owners' names, but not the bot's own "Notetaker for <name>". */
export function ownersPattern(names: string[]) {
  return new RegExp(`(?<!for )\\b(${names.map((n) => escapeRegExp(n.trim())).join("|")})\\b`, "i");
}

async function joinFromLobby(
  page: Page,
  botName: string,
  admitTimeoutMs: number,
  log: (m: string) => void,
  onWaitingRoom?: () => PromiseLike<unknown> | void,
  giveWay?: () => Promise<boolean>,
) {
  const blocked = page.getByText(BLOCKED_TEXT);

  // Guests type a name; a signed-in bot joins under its Google account name instead.
  const nameBox = page.getByRole("textbox", { name: /your name/i });
  const joinButton = page.getByRole("button", { name: /ask to join|join now/i });
  const findLobby = () =>
    Promise.race([
      nameBox.waitFor({ timeout: 45_000 }).then(() => "guest" as const),
      joinButton.waitFor({ timeout: 45_000 }).then(() => "signed-in" as const),
      blocked.waitFor({ timeout: 45_000 }).then(() => "blocked" as const),
    ]).catch(() => "unknown" as const);
  let lobby = await findLobby();
  if (lobby === "unknown") {
    // A busy server can leave the lobby half drawn; one reload usually brings the button back.
    log(`No join button yet; reloading. Buttons: ${(await visibleButtons(page)).join(" | ")}`);
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await prepareLobby(page);
    lobby = await findLobby();
  }
  if (lobby === "blocked") throw new JoinFailed(BLOCKED_MESSAGE, "blocked");
  if (lobby === "unknown") {
    log(`Still no join button. Buttons: ${(await visibleButtons(page)).join(" | ")}`);
    throw new JoinFailed("Could not find the join button on the Meet lobby page", "error");
  }
  if (lobby === "guest") await nameBox.fill(botName);

  await joinButton.click({ timeout: 15_000 });
  log("Asked to join; waiting to be admitted");
  await Promise.resolve(onWaitingRoom?.()).catch((err) => log(`Status update failed: ${err}`));

  // Newer Meet shows the leave button in the waiting room too, so "in the call" also needs
  // the waiting text gone.
  const inCall = page.getByRole("button", { name: /leave call/i });
  const waiting = page.getByText(WAITING_TEXT);
  const denied = page.getByText(/denied your request|no one responded to your request|you've been removed/i);
  const deadline = Date.now() + admitTimeoutMs;
  let outcome: "joined" | "denied" | "blocked" | "timeout" = "timeout";
  let inCallChecks = 0;
  let checks = 0;
  while (Date.now() < deadline) {
    if (await denied.first().isVisible().catch(() => false)) {
      outcome = "denied";
      break;
    }
    if (await blocked.first().isVisible().catch(() => false)) {
      outcome = "blocked";
      break;
    }
    const admitted =
      (await inCall.first().isVisible().catch(() => false)) && !(await waiting.first().isVisible().catch(() => false));
    // Two checks in a row, so a waiting-room screen that's still drawing doesn't count.
    inCallChecks = admitted ? inCallChecks + 1 : 0;
    if (inCallChecks >= 2) {
      outcome = "joined";
      break;
    }
    if (page.isClosed()) throw new JoinFailed("The lobby page closed", "error");
    if (giveWay && ++checks % 10 === 0 && (await giveWay().catch(() => false))) {
      throw new JoinFailed("Stopped waiting to be let in: a call you sent the bot to needed it", "timeout");
    }
    await sleep(1_000);
  }

  if (outcome === "denied") throw new JoinFailed("The host didn't let the bot in", "denied");
  if (outcome === "blocked") throw new JoinFailed(BLOCKED_MESSAGE, "blocked");
  if (outcome === "timeout") throw new JoinFailed(`Not admitted: nobody let the bot in within ${Math.round(admitTimeoutMs / 60_000)} minutes`, "timeout");
}

const WAITING_TEXT =
  /please wait until a meeting host brings you into the call|asking to be let in|someone in the call (needs to|will) let you in|you'll join the call when someone lets you in|waiting for the host/i;

const CHAT_RESTRICTED = /only .{0,80} can send messages|can't send messages|chat (is|has been) (turned off|restricted|disabled)|messages are turned off/i;

/** Posts the recording notice in the chat, unless the host has restricted who can chat. */
async function announce(page: Page, botName: string, log: (m: string) => void) {
  const chatButton = page.getByRole("button", { name: /chat with everyone/i });
  await chatButton.click({ timeout: 10_000 });
  try {
    const box = page.getByRole("textbox", { name: /send a message/i });
    const ready = await box
      .waitFor({ timeout: 5_000 })
      .then(() => box.isEditable())
      .catch(() => false);
    if (!ready || (await page.getByText(CHAT_RESTRICTED).first().isVisible().catch(() => false))) {
      log("Chat is restricted for the bot; skipping the consent message");
      return;
    }
    await box.fill(
      `${botName} is recording and transcribing this meeting to take notes. Remove me from the call if you don't want that.`,
      { timeout: 10_000 },
    );
    await box.press("Enter");
  } finally {
    // Close the chat panel again.
    await chatButton.click({ timeout: 5_000 }).catch(() => {});
  }
}

/**
 * Reads the People panel. Returns null when it can't be found, so callers can fall back to
 * Meet's "only one here" banner.
 */
async function participants(page: Page): Promise<string[] | null> {
  const list = page.getByRole("list", { name: /participants/i }).first();
  if (!(await list.isVisible().catch(() => false))) {
    await page
      .getByRole("button", { name: /^(people|show everyone)/i })
      .first()
      .click({ timeout: 3_000 })
      .catch(() => {});
    if (!(await list.waitFor({ timeout: 3_000 }).then(() => true).catch(() => false))) return null;
  }
  return list
    .getByRole("listitem")
    .evaluateAll((items) => items.map((el) => el.getAttribute("aria-label") || el.textContent || "").filter(Boolean))
    .catch(() => null);
}

/** Turns on Meet's captions so the bot can see who is speaking. */
/** Closes Meet's tips and notices ("Got it", "Dismiss"), which can cover the captions button. */
async function dismissPopups(page: Page) {
  const buttons = page.getByRole("button", { name: /^(got it|dismiss|close|ok|no thanks|not now)$/i });
  for (let i = 0; i < 5; i++) {
    const button = buttons.first();
    if (!(await button.isVisible().catch(() => false))) return;
    await button.click({ timeout: 2_000 }).catch(() => {});
  }
}

async function enableCaptions(page: Page, log: (m: string) => void) {
  // The watcher polls for the captions area itself, so it's safe to start before captions show up.
  await page.evaluate(installCaptionWatcher);
  await dismissPopups(page);

  // Each way of turning captions on is a toggle, so only try the next one once captions are
  // clearly still off. Meet can take several seconds to turn them on.
  const attempts: Array<[string, () => Promise<unknown>]> = [
    ["button", () => page.getByRole("button", { name: /turn on captions/i }).first().click({ timeout: 3_000 })],
    [
      "menu",
      async () => {
        await page.getByRole("button", { name: /more options/i }).first().click({ timeout: 3_000 });
        await page.getByRole("menuitem", { name: /turn on captions/i }).first().click({ timeout: 3_000 });
      },
    ],
    [
      "shortcut",
      async () => {
        // "c" is Meet's shortcut, but not while a text box (the chat) has focus.
        await page.keyboard.press("Escape");
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.keyboard.press("c");
      },
    ],
  ];
  for (const [how, attempt] of attempts) {
    const state = await captionsState(page);
    if (state === "on") return log("Captions on; noting who speaks");
    await attempt().catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    const after = await waitForCaptions(page, 10_000);
    if (after === "on") return log(`Captions on (${how}); noting who speaks`);
    if (after === "unknown") break; // can't tell; another toggle might turn them off again
  }
  if ((await captionsState(page)) === "on") return log("Captions on; noting who speaks");

  // Leave a trail for fixing this: what the bot could press.
  const buttons = await visibleButtons(page);
  log(`Captions didn't turn on yet; will retry during the call. Buttons: ${buttons.join(" | ")}`);
}

/**
 * Whether Meet's captions are on, judged by the captions button's label (it flips between
 * "Turn on captions" and "Turn off captions") and by the captions area.
 */
export async function captionsState(page: Page): Promise<"on" | "off" | "unknown"> {
  const visible = (l: ReturnType<Page["getByRole"]>) => l.first().isVisible().catch(() => false);
  if (
    (await visible(page.getByRole("button", { name: /turn off captions/i }))) ||
    (await visible(page.getByRole("button", { name: /captions/i, pressed: true }))) ||
    (await visible(page.getByRole("region", { name: /captions/i })))
  ) {
    return "on";
  }
  return (await visible(page.getByRole("button", { name: /turn on captions/i }))) ? "off" : "unknown";
}

async function waitForCaptions(page: Page, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  let state = await captionsState(page);
  while (state !== "on" && Date.now() < until) {
    await sleep(500);
    state = await captionsState(page);
  }
  return state;
}

const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i;

/** The call's name from the tab title ("Meet – Weekly sync"), or null when it's only the code. */
export function titleFromTabTitle(tabTitle: string): string | null {
  const name = tabTitle
    .replace(/^\s*(google\s+)?meet\s*[-–—:|]\s*/i, "")
    .replace(/\s*[-–—|]\s*(google\s+)?meet\s*$/i, "")
    .trim();
  if (!name || name === tabTitle.trim() || MEET_CODE.test(name)) return null;
  return name;
}

async function meetingTitle(page: Page) {
  return titleFromTabTitle(await page.title().catch(() => ""));
}

type EndOptions = {
  leaveBy: Date;
  aloneTimeoutMs: number;
  owner: RegExp | null;
  ownerGoneMs: number;
  /** Collects every name seen in the People list. */
  seen: Set<string>;
  log: (m: string) => void;
};

const CAPTION_RETRY_MS = 15_000;

async function waitForEnd(page: Page, { leaveBy, aloneTimeoutMs, owner, ownerGoneMs, seen, log }: EndOptions) {
  const inCall = page.getByRole("button", { name: /leave call/i });
  const aloneBanner = page.getByText(/you're the only one here|everyone else has left/i);
  const ended = page.getByText(/you've been removed|the call has ended|you left the meeting/i);
  let aloneSince: number | null = null;
  let ownerSeen = false;
  let ownerGoneSince: number | null = null;
  let nextCaptionTry = Date.now() + CAPTION_RETRY_MS;

  for (;;) {
    if (Date.now() >= leaveBy.getTime()) return "scheduled end passed";
    if (page.isClosed()) return "page closed";
    if (await ended.first().isVisible().catch(() => false)) return "meeting ended or bot removed";
    if (!(await inCall.isVisible().catch(() => false))) return "no longer in the call";

    const people = await participants(page);
    people?.forEach((p) => seen.add(p.trim()));

    // Captions sometimes don't take right after joining; keep trying while the call runs.
    if (Date.now() >= nextCaptionTry && (await captionsState(page)) !== "on") {
      nextCaptionTry = Date.now() + CAPTION_RETRY_MS;
      await dismissPopups(page);
      // Meet hides its toolbar after a while; moving the mouse brings it back.
      await page.mouse.move(640, 600).catch(() => {});
      await page.getByRole("button", { name: /turn on captions/i }).first().click({ timeout: 3_000 }).catch(() => {});
      log(`Retried captions: ${await waitForCaptions(page, 10_000)}`);
    }

    if (owner && people) {
      if (people.some((p) => owner.test(p))) {
        if (ownerGoneSince !== null) log("The owner rejoined");
        ownerSeen = true;
        ownerGoneSince = null;
      } else if (ownerSeen) {
        if (ownerGoneSince === null) log("The owner left; leaving soon unless they come back");
        ownerGoneSince ??= Date.now();
        if (Date.now() - ownerGoneSince >= ownerGoneMs) return "the owner left";
      }
    }

    // The People panel lists the bot too, so one entry means it's alone.
    const alone = people ? people.length <= 1 : await aloneBanner.first().isVisible().catch(() => false);
    if (alone) {
      aloneSince ??= Date.now();
      if (Date.now() - aloneSince >= aloneTimeoutMs) return "everyone else left";
    } else if (aloneSince !== null) {
      log("Someone rejoined");
      aloneSince = null;
    }
    // A plain timer: page.waitForTimeout throws once the browser is closed.
    await sleep(Math.min(5_000, ownerGoneMs, aloneTimeoutMs));
  }
}
