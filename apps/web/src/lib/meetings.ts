import "server-only";
import { botSessions, calendars, meetings, notes } from "@minuteflow/db";
import { and, asc, desc, eq, gte, isNotNull, isNull, lte, or, type SQL } from "drizzle-orm";
import type { BotStatus } from "@/components/ui";
import { db } from "@/lib/db";
import type { MeetingPlatform } from "@/lib/meeting-links";

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
  noteId: string | null;
}): MeetingRow {
  const { noteId, ...rest } = r;
  return {
    ...rest,
    hasNotes: noteId !== null,
    calendarName: r.calendarName ?? "Sent from a link",
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
  };
}

function base() {
  return db()
    .select(columns)
    .from(meetings)
    .leftJoin(calendars, eq(meetings.calendarId, calendars.id))
    .leftJoin(botSessions, eq(botSessions.meetingId, meetings.id))
    .leftJoin(notes, eq(notes.meetingId, meetings.id));
}

/** Meetings that haven't ended yet, soonest first. */
export async function upcomingMeetings(userId: string): Promise<MeetingRow[]> {
  const rows = await base()
    .where(and(visible(userId), gte(meetings.endsAt, new Date())))
    .orderBy(asc(meetings.startsAt))
    .limit(200);
  return rows.map(toRow);
}

/** Meetings the bot was sent to, newest first. */
export async function recordedMeetings(userId: string): Promise<MeetingRow[]> {
  const rows = await base()
    .where(and(visible(userId), isNotNull(botSessions.id), lte(meetings.startsAt, new Date())))
    .orderBy(desc(meetings.startsAt))
    .limit(200);
  return rows.map(toRow);
}

/** Meetings overlapping [from, to). */
export async function meetingsBetween(userId: string, from: Date, to: Date): Promise<MeetingRow[]> {
  const rows = await base()
    .where(and(visible(userId), gte(meetings.endsAt, from), lte(meetings.startsAt, to)))
    .orderBy(asc(meetings.startsAt))
    .limit(500);
  return rows.map(toRow);
}
