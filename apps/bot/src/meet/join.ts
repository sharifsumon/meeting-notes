import { chromium, type BrowserContext, type Page } from "playwright-core";
import { config, headless } from "../config";
import { installAudioCapture, installCaptionWatcher } from "./capture";

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
  /** Leave after being the only participant this long. */
  aloneTimeoutMs?: number;
  /**
   * The MinuteFlow user's display name in Meet. When set, the bot leaves `ownerGoneMs` after they
   * leave the call. It still asks to join right away: Meet hides who's in a call from accounts
   * outside the host's organization, so the lobby can't tell whether the owner is there.
   */
  ownerName?: string | null;
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

const BROWSER_ARGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  "--disable-blink-features=AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
  "--lang=en-US",
];

/**
 * Opens a browser context: the signed-in bot profile when BOT_PROFILE_DIR is set
 * (one meeting at a time, since a profile can't be shared), otherwise a fresh guest.
 */
export async function launchContext(): Promise<BrowserContext> {
  const options = { permissions: ["microphone", "camera"], locale: "en-US" };
  if (config.BOT_PROFILE_DIR) {
    return chromium.launchPersistentContext(config.BOT_PROFILE_DIR, {
      ...options,
      executablePath: config.CHROME_PATH,
      headless,
      args: BROWSER_ARGS,
    });
  }
  const browser = await chromium.launch({ executablePath: config.CHROME_PATH, headless, args: BROWSER_ARGS });
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
  try {
    const page = await context.newPage();
    await preparePage(page, opts.onChunk);

    log(`Opening ${opts.url}`);
    await page.goto(withEnglishUi(opts.url), { waitUntil: "domcontentloaded" });

    const owner = opts.ownerName ? ownerPattern(opts.ownerName) : null;
    await prepareLobby(page);

    await joinFromLobby(page, opts.botName, opts.admitTimeoutMs ?? 10 * 60_000, log, opts.onWaitingRoom);
    const joinedAt = new Date();
    log("In the meeting; recording");

    await page.evaluate(() => (window as unknown as { __mfStart: () => void }).__mfStart());
    const levelTimer = setInterval(() => void logLevel(page, log), opts.levelLogMs ?? 60_000);
    await Promise.resolve(opts.onAdmitted?.(joinedAt)).catch((err) => log(`Status update failed: ${err}`));
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

    await page
      .evaluate(() => (window as unknown as { __mfStop: () => Promise<void> }).__mfStop())
      .catch((err) => log(`Stopping recorder failed: ${err}`));
    await page.getByRole("button", { name: /leave call/i }).click({ timeout: 5_000 }).catch(() => {});
    const bot = ownerPattern(opts.botName);
    const participants = [...seen].filter((n) => !bot.test(n) && n !== opts.botName);
    return { joinedAt, leftAt: new Date(), reason, title, participants, speakerTimeline };
  } finally {
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

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches the owner's name, but not the bot's own "Notetaker for <name>". */
export function ownerPattern(name: string) {
  return new RegExp(`(?<!for )\\b${escapeRegExp(name.trim())}\\b`, "i");
}

async function joinFromLobby(
  page: Page,
  botName: string,
  admitTimeoutMs: number,
  log: (m: string) => void,
  onWaitingRoom?: () => PromiseLike<unknown> | void,
) {
  const blocked = page.getByText(BLOCKED_TEXT);

  // Guests type a name; a signed-in bot joins under its Google account name instead.
  const nameBox = page.getByRole("textbox", { name: /your name/i });
  const joinButton = page.getByRole("button", { name: /ask to join|join now/i });
  const lobby = await Promise.race([
    nameBox.waitFor({ timeout: 30_000 }).then(() => "guest" as const),
    joinButton.waitFor({ timeout: 30_000 }).then(() => "signed-in" as const),
    blocked.waitFor({ timeout: 30_000 }).then(() => "blocked" as const),
  ]).catch(() => "unknown" as const);
  if (lobby === "blocked") throw new JoinFailed(BLOCKED_MESSAGE, "blocked");
  if (lobby === "unknown") throw new JoinFailed("Could not find the join button on the Meet lobby page", "error");
  if (lobby === "guest") await nameBox.fill(botName);

  await joinButton.click({ timeout: 15_000 });
  log("Asked to join; waiting to be admitted");
  await Promise.resolve(onWaitingRoom?.()).catch((err) => log(`Status update failed: ${err}`));

  const inCall = page.getByRole("button", { name: /leave call/i });
  const denied = page.getByText(/denied your request|no one responded to your request|you've been removed/i);
  const outcome = await Promise.race([
    inCall.waitFor({ timeout: admitTimeoutMs }).then(() => "joined" as const),
    denied.waitFor({ timeout: admitTimeoutMs }).then(() => "denied" as const),
    blocked.waitFor({ timeout: admitTimeoutMs }).then(() => "blocked" as const),
  ]).catch(() => "timeout" as const);

  if (outcome === "denied") throw new JoinFailed("The host didn't let the bot in", "denied");
  if (outcome === "blocked") throw new JoinFailed(BLOCKED_MESSAGE, "blocked");
  if (outcome === "timeout") throw new JoinFailed("Nobody admitted the bot in time", "timeout");
}

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
async function enableCaptions(page: Page, log: (m: string) => void) {
  const region = page.getByRole("region", { name: /captions/i }).first();
  const button = page.getByRole("button", { name: /turn on captions/i }).first();
  if (await button.isVisible().catch(() => false)) {
    await button.click({ timeout: 5_000 });
  } else {
    // "c" is Meet's captions shortcut; the button can be hidden in a narrow window.
    await page.keyboard.press("c");
  }
  const on = await region
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!on) {
    log("Captions didn't turn on; speakers will be numbered");
    return;
  }
  await page.evaluate(installCaptionWatcher);
  log("Captions on; noting who speaks");
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

async function waitForEnd(page: Page, { leaveBy, aloneTimeoutMs, owner, ownerGoneMs, seen, log }: EndOptions) {
  const inCall = page.getByRole("button", { name: /leave call/i });
  const aloneBanner = page.getByText(/you're the only one here|everyone else has left/i);
  const ended = page.getByText(/you've been removed|the call has ended|you left the meeting/i);
  let aloneSince: number | null = null;
  let ownerSeen = false;
  let ownerGoneSince: number | null = null;

  for (;;) {
    if (Date.now() >= leaveBy.getTime()) return "scheduled end passed";
    if (page.isClosed()) return "page closed";
    if (await ended.first().isVisible().catch(() => false)) return "meeting ended or bot removed";
    if (!(await inCall.isVisible().catch(() => false))) return "no longer in the call";

    const people = await participants(page);
    people?.forEach((p) => seen.add(p.trim()));

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
    await page.waitForTimeout(Math.min(5_000, ownerGoneMs, aloneTimeoutMs));
  }
}
