import { chromium, type Browser, type Page } from "playwright-core";
import { config, headless } from "../config";
import { installAudioCapture } from "./capture";

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

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ executablePath: config.CHROME_PATH, headless, args: BROWSER_ARGS });
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
export async function recordMeet(opts: MeetSessionOptions): Promise<{ joinedAt: Date; leftAt: Date; reason: string }> {
  const log = opts.log ?? console.log;
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ permissions: ["microphone", "camera"], locale: "en-US" });
    const page = await context.newPage();
    await preparePage(page, opts.onChunk);

    log(`Opening ${opts.url}`);
    await page.goto(withEnglishUi(opts.url), { waitUntil: "domcontentloaded" });

    await joinFromLobby(page, opts.botName, opts.admitTimeoutMs ?? 10 * 60_000, log);
    const joinedAt = new Date();
    log("In the meeting; recording");

    await page.evaluate(() => (window as unknown as { __mfStart: () => void }).__mfStart());
    await announce(page, opts.botName).catch((err) => log(`Could not post consent message: ${err}`));

    const reason = await waitForEnd(page, opts.leaveBy, opts.aloneTimeoutMs ?? 60_000, log);
    log(`Leaving: ${reason}`);

    await page
      .evaluate(() => (window as unknown as { __mfStop: () => Promise<void> }).__mfStop())
      .catch((err) => log(`Stopping recorder failed: ${err}`));
    await page.getByRole("button", { name: /leave call/i }).click({ timeout: 5_000 }).catch(() => {});
    return { joinedAt, leftAt: new Date(), reason };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function joinFromLobby(page: Page, botName: string, admitTimeoutMs: number, log: (m: string) => void) {
  const blocked = page.getByText(/you can't join this video call|unable to join this call/i);

  // Dismiss "Got it" style dialogs, then turn mic and camera off.
  await page.getByRole("button", { name: /^got it$/i }).click({ timeout: 5_000 }).catch(() => {});
  for (const name of [/turn off microphone/i, /turn off camera/i]) {
    await page.getByRole("button", { name }).first().click({ timeout: 10_000 }).catch(() => {});
  }

  const nameBox = page.getByRole("textbox", { name: /your name/i });
  try {
    await nameBox.fill(botName, { timeout: 30_000 });
  } catch {
    if (await blocked.isVisible()) throw new JoinFailed("Google Meet refused to let the bot in", "blocked");
    throw new JoinFailed("Could not find the name field on the Meet lobby page", "error");
  }

  await page.getByRole("button", { name: /ask to join|join now/i }).click({ timeout: 15_000 });
  log("Asked to join; waiting to be admitted");

  const inCall = page.getByRole("button", { name: /leave call/i });
  const denied = page.getByText(/denied your request|no one responded to your request|you've been removed/i);
  const outcome = await Promise.race([
    inCall.waitFor({ timeout: admitTimeoutMs }).then(() => "joined" as const),
    denied.waitFor({ timeout: admitTimeoutMs }).then(() => "denied" as const),
    blocked.waitFor({ timeout: admitTimeoutMs }).then(() => "blocked" as const),
  ]).catch(() => "timeout" as const);

  if (outcome === "denied") throw new JoinFailed("The host didn't let the bot in", "denied");
  if (outcome === "blocked") throw new JoinFailed("Google Meet refused to let the bot in", "blocked");
  if (outcome === "timeout") throw new JoinFailed("Nobody admitted the bot in time", "timeout");
}

async function announce(page: Page, botName: string) {
  await page.getByRole("button", { name: /chat with everyone/i }).click({ timeout: 10_000 });
  const box = page.getByRole("textbox", { name: /send a message/i });
  await box.fill(
    `${botName} is recording and transcribing this meeting to take notes. Remove me from the call if you don't want that.`,
    { timeout: 10_000 },
  );
  await box.press("Enter");
  // Close the chat panel again.
  await page.getByRole("button", { name: /chat with everyone/i }).click({ timeout: 5_000 }).catch(() => {});
}

async function waitForEnd(page: Page, leaveBy: Date, aloneTimeoutMs: number, log: (m: string) => void) {
  const inCall = page.getByRole("button", { name: /leave call/i });
  const alone = page.getByText(/you're the only one here|everyone else has left/i);
  const ended = page.getByText(/you've been removed|the call has ended|you left the meeting/i);
  let aloneSince: number | null = null;

  for (;;) {
    if (Date.now() >= leaveBy.getTime()) return "scheduled end passed";
    if (page.isClosed()) return "page closed";
    if (await ended.first().isVisible().catch(() => false)) return "meeting ended or bot removed";
    if (!(await inCall.isVisible().catch(() => false))) return "no longer in the call";

    if (await alone.first().isVisible().catch(() => false)) {
      aloneSince ??= Date.now();
      if (Date.now() - aloneSince >= aloneTimeoutMs) return "everyone else left";
    } else if (aloneSince !== null) {
      log("Someone rejoined");
      aloneSince = null;
    }
    await page.waitForTimeout(5_000);
  }
}
