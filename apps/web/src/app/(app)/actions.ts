"use server";

import { rm } from "node:fs/promises";
import path from "node:path";
import { AD_HOC_MEETING_TITLE, botSessions, calendars, meetings, notes, users } from "@minuteflow/db";
import { and, eq, gt, inArray, isNotNull, isNull, lte, notInArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { env } from "@/env";
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
    .where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId), isNull(meetings.deletedAt)));
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
        isNull(meetings.deletedAt),
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
        isNull(meetings.deletedAt),
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
        isNull(meetings.deletedAt),
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

// A bot in one of these states is in (or about to be in) the call.
const BOT_BUSY = ["joining", "waiting_room", "recording"] as const;

/**
 * Deletes a meeting with its recording, transcript, notes and bot sessions. A calendar meeting
 * keeps a deleted marker so the next calendar sync doesn't bring it back; the calendar event
 * itself is left alone.
 */
export async function deleteMeeting(meetingId: string): Promise<ActionResult> {
  const userId = await requireUserId();
  const [meeting] = await db()
    .select({ id: meetings.id, calendarId: meetings.calendarId })
    .from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId), isNull(meetings.deletedAt)));
  if (!meeting) return { error: "This meeting was already deleted." };

  const sessions = await db()
    .select({ id: botSessions.id, status: botSessions.status, key: botSessions.recordingKey })
    .from(botSessions)
    .where(eq(botSessions.meetingId, meetingId));
  if (sessions.some((s) => (BOT_BUSY as readonly string[]).includes(s.status))) {
    return { error: "The notetaker is in this call right now. Delete the meeting after it leaves." };
  }

  // Stop the bot first so it can't join while the rest is removed. A queued join finds no session and skips.
  if (meeting.calendarId) {
    await db()
      .update(meetings)
      .set({ deletedAt: new Date(), recordEnabled: false, botRequestedAt: null })
      .where(eq(meetings.id, meetingId));
  }
  if (sessions.length) {
    // Transcripts go with their bot session.
    await db()
      .delete(botSessions)
      .where(
        inArray(
          botSessions.id,
          sessions.map((s) => s.id),
        ),
      );
  }
  await db().delete(notes).where(eq(notes.meetingId, meetingId));
  // Meetings sent from a link aren't on a calendar, so there's nothing to keep.
  if (!meeting.calendarId) await db().delete(meetings).where(eq(meetings.id, meetingId));

  const root = path.resolve(env().STORAGE_DIR);
  for (const s of sessions) {
    if (!s.key) continue;
    const file = path.resolve(root, s.key);
    if (!file.startsWith(root + path.sep)) continue;
    await rm(file, { force: true }).catch((err) => console.error(`Couldn't delete recording ${file}`, err));
  }

  revalidatePath("/meetings");
  revalidatePath("/calendar");
  return {};
}
