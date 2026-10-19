import "server-only";
import { botSessions, calendars, meetings, notes } from "@minuteflow/db";
import { and, asc, desc, eq, gte, isNotNull, isNull, lte, inArray, or, type SQL } from "drizzle-orm";
import { wasNotLetIn, type BotStatus } from "@/components/ui";
import { db } from "@/lib/db";
import { meetCode, type MeetingPlatform } from "@/lib/meeting-links";

/** A meeting as the browser sees it: dates as ISO strings so they can cross to client components. */
export type MeetingRow = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  meetingUrl: string | null;
  platform: MeetingPlatform | null;
  recordEnabled: boolean;
  calendarName: string;
  status: BotStatus | null;
  hasNotes: boolean;
  /** The bot failed because nobody let it into the call. */
  notLetIn: boolean;
};

const columns = {
  id: meetings.id,
  title: meetings.title,
  startsAt: meetings.startsAt,
  endsAt: meetings.endsAt,
  meetingUrl: meetings.meetingUrl,
  platform: meetings.platform,
  recordEnabled: meetings.recordEnabled,
  calendarName: calendars.name,
  status: botSessions.status,
  error: botSessions.error,
  noteId: notes.id,
};

function visible(userId: string): SQL {
  // Meetings from calendars the user turned off are hidden; ones sent from a link have no calendar.
  return and(
    eq(meetings.userId, userId),
    or(isNull(meetings.calendarId), eq(calendars.enabled, true)),
    eq(meetings.cancelled, false),
    isNull(meetings.deletedAt),
  )!;
}

function toRow(r: {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  meetingUrl: string | null;
  platform: MeetingPlatform | null;
  recordEnabled: boolean;
  calendarName: string | null;
  status: BotStatus | null;
  error: string | null;
  noteId: string | null;
}): MeetingRow {
  const { noteId, error, ...rest } = r;
  return {
    ...rest,
    hasNotes: noteId !== null,
    notLetIn: r.status === "failed" && wasNotLetIn(error),
    calendarName: r.calendarName ?? "Sent from a link",
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
  };
}

/**
 * Joins a meeting to its bot session: its own, or the one shared from another MinuteFlow user who
 * had the same call on their calendar. A meeting never has both.
 */
export function sessionOf(): SQL {
  return or(eq(botSessions.meetingId, meetings.id), eq(botSessions.id, meetings.sharedSessionId))!;
}

/**
 * The same event can arrive from several of a user's calendars (a team calendar and their own, or
 * two accounts). Lists show it once, keeping the copy the bot is attached to.
 */
export function oneCopyEach(rows: MeetingRow[]): MeetingRow[] {
  const rank = (r: MeetingRow) => (r.hasNotes ? 2 : r.status ? 1 : 0);
  const best = new Map<string, MeetingRow>();
  for (const r of rows) {
    const key = `${meetCode(r.meetingUrl) ?? r.meetingUrl ?? r.id}|${r.startsAt}`;
    const seen = best.get(key);
    if (!seen || rank(r) > rank(seen)) best.set(key, r);
  }
  const keep = new Set(best.values());
  return rows.filter((r) => keep.has(r));
}

function base() {
  return db()
    .select(columns)
    .from(meetings)
    .leftJoin(calendars, eq(meetings.calendarId, calendars.id))
    .leftJoin(botSessions, sessionOf())
    .leftJoin(notes, eq(notes.meetingId, botSessions.meetingId));
}

/** Meetings that haven't ended yet, soonest first. */
export async function upcomingMeetings(userId: string): Promise<MeetingRow[]> {
  const rows = await base()
    .where(and(visible(userId), gte(meetings.endsAt, new Date())))
    .orderBy(asc(meetings.startsAt))
    .limit(200);
  return oneCopyEach(rows.map(toRow));
}

/** Meetings the bot is recording or has recorded, newest first; calls still joining, waiting or never let in stay out. */
export async function recordedMeetings(userId: string): Promise<MeetingRow[]> {
  const rows = await base()
    .where(
      and(
        visible(userId),
        isNotNull(botSessions.id),
        inArray(botSessions.status, ["recording", "processing", "completed"]),
        lte(meetings.startsAt, new Date()),
      ),
    )
    .orderBy(desc(meetings.startsAt))
    .limit(200);
  return oneCopyEach(rows.map(toRow));
}

/** Meetings overlapping [from, to). */
export async function meetingsBetween(userId: string, from: Date, to: Date): Promise<MeetingRow[]> {
  const rows = await base()
    .where(and(visible(userId), gte(meetings.endsAt, from), lte(meetings.startsAt, to)))
    .orderBy(asc(meetings.startsAt))
    .limit(500);
  return oneCopyEach(rows.map(toRow));
}
