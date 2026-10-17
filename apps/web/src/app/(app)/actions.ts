"use server";

import { AD_HOC_MEETING_TITLE, botSessions, calendars, meetings, users } from "@minuteflow/db";
import { and, eq, gt, isNotNull, lte, notInArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { detectMeetingLink, meetCode } from "@/lib/meeting-links";
import { GoogleReconnectRequired } from "@/lib/google/client";
import { requireUserId } from "@/lib/session";
import { syncAll, syncMeetings } from "@/lib/sync";

export type ActionResult = { error?: string };

async function runSync(fn: () => Promise<void>): Promise<ActionResult> {
  try {
    await fn();
    return {};
  } catch (err) {
    if (err instanceof GoogleReconnectRequired) redirect("/settings?reconnect=1");
    console.error("Calendar sync failed", err);
    return { error: "Couldn't reach Google Calendar. Try again in a moment." };
  }
}

export async function syncNow(): Promise<ActionResult> {
  const userId = await requireUserId();
  const result = await runSync(() => syncAll(userId));
  revalidatePath("/meetings");
  revalidatePath("/settings");
  return result;
}

export async function setRecordEnabled(meetingId: string, enabled: boolean) {
  const userId = await requireUserId();
  await db()
    .update(meetings)
    .set({ recordEnabled: enabled })
    .where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId)));
  revalidatePath("/meetings");
}

export async function setCalendarEnabled(calendarId: string, enabled: boolean): Promise<ActionResult> {
  const userId = await requireUserId();
  await db()
    .update(calendars)
    .set({ enabled })
    .where(and(eq(calendars.id, calendarId), eq(calendars.userId, userId)));
  const result = enabled ? await runSync(() => syncMeetings(userId)) : {};
  revalidatePath("/meetings");
  revalidatePath("/settings");
  return result;
}

/** Turns on the notetaker for every upcoming Meet call that doesn't have a bot yet. */
async function recordUpcoming(userId: string) {
  const withBot = db().select({ id: botSessions.meetingId }).from(botSessions);
  await db()
    .update(meetings)
    .set({ recordEnabled: true })
    .where(
      and(
        eq(meetings.userId, userId),
        eq(meetings.platform, "google_meet"),
        eq(meetings.cancelled, false),
        gt(meetings.endsAt, new Date()),
        notInArray(meetings.id, withBot),
      ),
    );
}

/** "Record all my meetings automatically". Turning it on also covers meetings already synced. */
export async function setAutoRecord(enabled: boolean): Promise<ActionResult> {
  const userId = await requireUserId();
  await db().update(users).set({ autoRecord: enabled }).where(eq(users.id, userId));
  if (enabled) await recordUpcoming(userId);
  revalidatePath("/settings");
  revalidatePath("/meetings");
  return {};
}

/** "Send bot now" on a calendar meeting: the bot joins right away instead of at the start time. */
export async function sendBotToMeeting(meetingId: string): Promise<ActionResult> {
  const userId = await requireUserId();
  const withBot = db().select({ id: botSessions.meetingId }).from(botSessions);
  const updated = await db()
    .update(meetings)
    .set({ recordEnabled: true, botRequestedAt: new Date() })
    .where(
      and(
        eq(meetings.id, meetingId),
        eq(meetings.userId, userId),
        eq(meetings.platform, "google_meet"),
        eq(meetings.cancelled, false),
        gt(meetings.endsAt, new Date()),
        notInArray(meetings.id, withBot),
      ),
    )
    .returning({ id: meetings.id });
  revalidatePath("/meetings");
  revalidatePath(`/meetings/${meetingId}`);
  return updated.length ? {} : { error: "The bot is already on its way, or this meeting has ended." };
}

const CONSENT_VERSION = "2026-10-15";

/** The onboarding agreement: read the calendar and record Meet calls automatically. */
export async function giveConsent(formData: FormData) {
  const userId = await requireUserId();
  if (formData.get("agree") !== "on") redirect("/welcome?missing=1");
  await db()
    .update(users)
    .set({ consentedAt: new Date(), consentVersion: CONSENT_VERSION, autoRecord: true })
    .where(eq(users.id, userId));
  let reconnect = false;
  try {
    await syncAll(userId);
  } catch (err) {
    reconnect = err instanceof GoogleReconnectRequired;
    if (!reconnect) console.error("Calendar sync after consent failed", err);
  }
  await recordUpcoming(userId);
  redirect(reconnect ? "/settings?reconnect=1" : "/meetings");
}

const AD_HOC_DURATION_MS = 2 * 60 * 60 * 1000;
// A calendar event starting this soon (or already running) is the call the link is for.
const MATCH_EARLY_MS = 15 * 60 * 1000;

/** The user's calendar event for this Meet call happening now, if there is one. */
async function calendarMeetingFor(userId: string, url: string, now: Date) {
  const code = meetCode(url);
  if (!code) return null;
  const rows = await db()
    .select({ id: meetings.id, title: meetings.title, meetingUrl: meetings.meetingUrl })
    .from(meetings)
    .where(
      and(
        eq(meetings.userId, userId),
        isNotNull(meetings.calendarId),
        eq(meetings.cancelled, false),
        lte(meetings.startsAt, new Date(now.getTime() + MATCH_EARLY_MS)),
        gt(meetings.endsAt, now),
      ),
    );
  return rows.find((r) => meetCode(r.meetingUrl) === code) ?? null;
}

/**
 * Sends the bot to a meeting right now from a pasted link. When the link belongs to a calendar
 * event happening now, the bot goes to that meeting (and keeps its title).
 */
export async function sendBotNow(link: string): Promise<ActionResult> {
  const userId = await requireUserId();
  const detected = detectMeetingLink(link.trim());
  if (!detected) return { error: "That doesn't look like a meeting link." };
  if (detected.platform !== "google_meet") return { error: "Only Google Meet links are supported for now." };

  const now = new Date();
  // Make sure an event created a moment ago is in the table.
  await syncMeetings(userId).catch((err) => console.error("Calendar sync before sending the bot failed", err));
  const event = await calendarMeetingFor(userId, detected.url, now);
  if (event) {
    await db().update(meetings).set({ recordEnabled: true }).where(eq(meetings.id, event.id));
    revalidatePath("/meetings");
    return {};
  }

  await db()
    .insert(meetings)
    .values({
      userId,
      // The bot replaces this with the call's name from Meet when it has one.
      title: AD_HOC_MEETING_TITLE,
      startsAt: now,
      endsAt: new Date(now.getTime() + AD_HOC_DURATION_MS),
      meetingUrl: detected.url,
      platform: detected.platform,
      recordEnabled: true,
    });
  revalidatePath("/meetings");
  return {};
}
