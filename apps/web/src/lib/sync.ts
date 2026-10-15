import "server-only";
import { calendars, meetings, users } from "@minuteflow/db";
import { and, eq, gte, lt, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { listCalendars, listEvents } from "@/lib/google/calendar";
import { normalizeGoogleEvent } from "@/lib/google/normalize";

const LOOKBACK_MS = 60 * 60 * 1000;
const LOOKAHEAD_MS = 14 * 24 * 60 * 60 * 1000;

/** Refreshes the user's list of Google calendars. The primary calendar is enabled on first sight. */
export async function syncCalendarList(userId: string) {
  const remote = await listCalendars(userId);
  for (const cal of remote) {
    await db()
      .insert(calendars)
      .values({
        userId,
        provider: "google",
        externalId: cal.id,
        name: cal.summaryOverride ?? cal.summary,
        isPrimary: cal.primary ?? false,
        enabled: cal.primary ?? false,
        timeZone: cal.timeZone ?? null,
      })
      .onConflictDoUpdate({
        target: [calendars.userId, calendars.provider, calendars.externalId],
        set: {
          name: sql`excluded.name`,
          isPrimary: sql`excluded.is_primary`,
          timeZone: sql`excluded.time_zone`,
        },
      });
  }
}

/** Pulls upcoming events from every enabled calendar into `meetings`. */
export async function syncMeetings(userId: string) {
  const now = Date.now();
  const timeMin = new Date(now - LOOKBACK_MS);
  const timeMax = new Date(now + LOOKAHEAD_MS);

  const enabled = await db()
    .select()
    .from(calendars)
    .where(and(eq(calendars.userId, userId), eq(calendars.enabled, true)));
  const [user] = await db()
    .select({ consentedAt: users.consentedAt, autoRecord: users.autoRecord })
    .from(users)
    .where(eq(users.id, userId));
  // Nothing is recorded automatically until the user has agreed to it.
  const autoRecord = Boolean(user?.consentedAt && user.autoRecord);

  for (const cal of enabled) {
    const events = (await listEvents(userId, cal.externalId, timeMin, timeMax))
      .map(normalizeGoogleEvent)
      .filter((e) => e !== null);

    for (const e of events) {
      await db()
        .insert(meetings)
        .values({
          userId,
          calendarId: cal.id,
          ...e,
          // New upcoming Meet calls get the notetaker when the user records automatically.
          recordEnabled: autoRecord && e.platform === "google_meet" && !e.cancelled && e.endsAt.getTime() > now,
        })
        .onConflictDoUpdate({
          target: [meetings.calendarId, meetings.externalEventId],
          // recordEnabled is the user's choice; never overwrite it from the calendar.
          set: {
            title: e.title,
            startsAt: e.startsAt,
            endsAt: e.endsAt,
            meetingUrl: e.meetingUrl,
            platform: e.platform,
            cancelled: e.cancelled,
          },
        });
    }

    // Events deleted from the calendar no longer come back from the API: mark them cancelled.
    const seen = events.map((e) => e.externalEventId);
    await db()
      .update(meetings)
      .set({ cancelled: true })
      .where(
        and(
          eq(meetings.calendarId, cal.id),
          gte(meetings.startsAt, timeMin),
          lt(meetings.startsAt, timeMax),
          ...(seen.length ? [notInArray(meetings.externalEventId, seen)] : []),
        ),
      );

    await db().update(calendars).set({ lastSyncedAt: new Date() }).where(eq(calendars.id, cal.id));
  }
}

export async function syncAll(userId: string) {
  await syncCalendarList(userId);
  await syncMeetings(userId);
}

const BACKGROUND_EVERY_MS = 90_000;
const CALENDAR_LIST_EVERY_MS = 60 * 60_000;
let running = false;
let lastCalendarList = 0;

/** Syncs every user with an enabled calendar once. Errors are logged per user. */
export async function syncEveryone() {
  if (running) return;
  running = true;
  try {
    const listToo = Date.now() - lastCalendarList >= CALENDAR_LIST_EVERY_MS;
    if (listToo) lastCalendarList = Date.now();
    const users = await db()
      .selectDistinct({ userId: calendars.userId })
      .from(calendars)
      .where(eq(calendars.enabled, true));
    for (const { userId } of users) {
      try {
        if (listToo) await syncCalendarList(userId);
        await syncMeetings(userId);
      } catch (err) {
        console.error(`Background calendar sync failed for ${userId}: ${err}`);
      }
    }
  } finally {
    running = false;
  }
}

/** Keeps meetings fresh without anyone opening the app, so new events get the bot. */
export function startBackgroundSync() {
  const tick = () => void syncEveryone().catch((err) => console.error("Background calendar sync failed", err));
  setTimeout(tick, 5_000);
  setInterval(tick, BACKGROUND_EVERY_MS);
  console.log(`Background calendar sync every ${BACKGROUND_EVERY_MS / 1000}s`);
}
