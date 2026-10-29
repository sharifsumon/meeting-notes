import "server-only";
import { accounts, calendars, meetings, users } from "@minuteflow/db";
import { and, eq, gte, inArray, isNotNull, isNull, lt, ne, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { listCalendars, listEvents } from "@/lib/google/calendar";
import { GoogleApiError } from "@/lib/google/client";
import { guestEmails, normalizeGoogleEvent, type NormalizedEvent } from "@/lib/google/normalize";
import { meetCode } from "@/lib/meeting-links";
import { listOutlookCalendars, listOutlookEvents } from "@/lib/microsoft/calendar";
import { MICROSOFT_PROVIDER, MicrosoftApiError } from "@/lib/microsoft/client";
import { normalizeOutlookEvent, outlookGuestEmails } from "@/lib/microsoft/normalize";

const LOOKBACK_MS = 60 * 60 * 1000;
const LOOKAHEAD_MS = 14 * 24 * 60 * 60 * 1000;

/** Which sign-in providers (google, microsoft-entra-id) the user has linked. */
async function linkedProviders(userId: string) {
  const rows = await db().select({ provider: accounts.provider }).from(accounts).where(eq(accounts.userId, userId));
  return new Set(rows.map((r) => r.provider));
}

type RemoteCalendar = { externalId: string; name: string; isPrimary: boolean; timeZone: string | null };

async function saveCalendars(userId: string, provider: "google" | "microsoft", remote: RemoteCalendar[]) {
  for (const cal of remote) {
    await db()
      .insert(calendars)
      .values({ userId, provider, ...cal, enabled: cal.isPrimary })
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

/**
 * Refreshes the user's list of Google and Outlook calendars. The primary calendar is enabled on first sight.
 * One account failing doesn't stop the other; the first error is rethrown afterwards.
 */
export async function syncCalendarList(userId: string) {
  const linked = await linkedProviders(userId);
  const errors: unknown[] = [];
  if (linked.has("google") || !linked.has(MICROSOFT_PROVIDER)) {
    try {
      const remote = await listCalendars(userId);
      await saveCalendars(
        userId,
        "google",
        remote.map((c) => ({ externalId: c.id, name: c.summaryOverride ?? c.summary, isPrimary: c.primary ?? false, timeZone: c.timeZone ?? null })),
      );
    } catch (err) {
      errors.push(err);
    }
  }
  if (linked.has(MICROSOFT_PROVIDER)) {
    try {
      const remote = await listOutlookCalendars(userId);
      await saveCalendars(
        userId,
        "microsoft",
        remote.map((c) => ({ externalId: c.id, name: c.name, isPrimary: c.isDefaultCalendar ?? false, timeZone: null })),
      );
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length) throw errors[0];
}

/** One calendar's events in our shape, with the guest emails used for sharing. */
async function eventsOf(userId: string, cal: { provider: "google" | "microsoft"; externalId: string }, timeMin: Date, timeMax: Date) {
  if (cal.provider === "microsoft") {
    const listed = await listOutlookEvents(userId, cal.externalId, timeMin, timeMax);
    return listed.flatMap((o) => {
      const e = normalizeOutlookEvent(o);
      return e ? [{ ...e, guests: outlookGuestEmails(o) }] : [];
    });
  }
  const listed = await listEvents(userId, cal.externalId, timeMin, timeMax);
  return listed.flatMap((g) => {
    const e = normalizeGoogleEvent(g);
    return e ? [{ ...e, guests: guestEmails(g) }] : [];
  });
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

  const failures: unknown[] = [];
  for (const cal of enabled) {
    let events;
    try {
      events = await eventsOf(userId, cal, timeMin, timeMax);
    } catch (err) {
      // One calendar the provider won't list (removed, or free/busy only) shouldn't stop the others.
      const status = err instanceof GoogleApiError || err instanceof MicrosoftApiError ? err.status : 0;
      // Other failures (an account needing reconnecting) are reported after the remaining calendars sync.
      if (![403, 404].includes(status)) failures.push(err);
      else console.error(`Skipping calendar ${cal.id}: ${(err as Error).message}`);
      continue;
    }

    for (const { guests, ...e } of events) {
      const [row] = await db()
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
        })
        .returning({ id: meetings.id });
      if (row && e.platform === "google_meet" && e.meetingUrl) {
        await copyForInvitedUsers(userId, row.id, e, guests);
        await dropInvitedCopies(userId, e);
      }
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

    // Invited users' copies follow the event they came from.
    await db()
      .update(meetings)
      .set({ cancelled: true })
      .where(
        and(
          eq(meetings.cancelled, false),
          inArray(
            meetings.invitedFrom,
            db().select({ id: meetings.id }).from(meetings).where(and(eq(meetings.calendarId, cal.id), eq(meetings.cancelled, true))),
          ),
        ),
      );

    await db().update(calendars).set({ lastSyncedAt: new Date() }).where(eq(calendars.id, cal.id));
  }
  if (failures.length) throw failures[0];
}

/**
 * Other MinuteFlow users invited to this Meet call (matched by their account email) get their own
 * copy of it, so they see its recording and notes even when the event isn't on a calendar they
 * connected. Only one bot joins: the scheduler sends one per call, and the copies share its recording.
 */
async function copyForInvitedUsers(ownerId: string, sourceId: string, e: NormalizedEvent, guests: string[]) {
  if (!guests.length) return;
  const invited = await db()
    .select({ id: users.id, consentedAt: users.consentedAt, autoRecord: users.autoRecord })
    .from(users)
    .where(
      and(
        ne(users.id, ownerId),
        inArray(sql`lower(${users.email})`, guests),
        // Only Google-verified addresses: a Microsoft work account's email is set by its own organisation.
        inArray(users.id, db().select({ id: accounts.userId }).from(accounts).where(eq(accounts.provider, "google"))),
      ),
    );
  for (const user of invited) {
    const theirs = await db()
      .select({ id: meetings.id, invitedFrom: meetings.invitedFrom, meetingUrl: meetings.meetingUrl })
      .from(meetings)
      .where(and(eq(meetings.userId, user.id), eq(meetings.startsAt, e.startsAt)));
    const copy = theirs.find((m) => m.invitedFrom === sourceId);
    if (copy) {
      await db()
        .update(meetings)
        .set({ title: e.title, endsAt: e.endsAt, meetingUrl: e.meetingUrl, cancelled: e.cancelled })
        .where(eq(meetings.id, copy.id));
      continue;
    }
    // They already have this call (from their own calendar, another invite, or one they deleted).
    if (theirs.some((m) => meetCode(m.meetingUrl) === meetCode(e.meetingUrl))) continue;
    await db()
      .insert(meetings)
      .values({
        userId: user.id,
        invitedFrom: sourceId,
        ...e,
        externalEventId: null,
        recordEnabled:
          Boolean(user.consentedAt && user.autoRecord) && !e.cancelled && e.endsAt.getTime() > Date.now(),
      });
  }
}

/** Once the call is on the user's own calendar, the copy from someone else's invite is redundant. */
async function dropInvitedCopies(userId: string, e: NormalizedEvent) {
  const copies = await db()
    .select({ id: meetings.id, meetingUrl: meetings.meetingUrl })
    .from(meetings)
    .where(
      and(
        eq(meetings.userId, userId),
        eq(meetings.startsAt, e.startsAt),
        isNotNull(meetings.invitedFrom),
        isNull(meetings.deletedAt),
      ),
    );
  const ids = copies.filter((m) => meetCode(m.meetingUrl) === meetCode(e.meetingUrl)).map((m) => m.id);
  if (ids.length) await db().delete(meetings).where(inArray(meetings.id, ids));
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
