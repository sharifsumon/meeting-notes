import { botSessions, meetings, users } from "@minuteflow/db";
import { and, eq, gt, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { config } from "./config";
import { db } from "./db";
import { meetCode } from "./meet/links";
import { joinQueue } from "./queue";

// A bot for the same link within this window counts as the same call.
const RECENT_MS = 6 * 60 * 60 * 1000;
// Statuses of a bot that is (about to be) in a call.
const ACTIVE = ["scheduled", "joining", "waiting_room", "recording"] as const;
const RECORDED: string[] = ["processing", "completed"];
const DUPLICATE_ERROR = "Another bot is recording this call";

/**
 * Finds meetings marked for recording that are about to start (or that the user asked
 * to send the bot to now) and have no bot yet,
 * creates a bot session for each and queues the join. Safe to run repeatedly.
 */
export async function scheduleDueMeetings(now = new Date()) {
  // Earlier versions cancelled a copy for good, even against a bot that had already left.
  // Clear those so the meeting can still get its bot.
  await db
    .delete(botSessions)
    .where(
      and(
        eq(botSessions.status, "cancelled"),
        eq(botSessions.error, DUPLICATE_ERROR),
        inArray(botSessions.meetingId, db.select({ id: meetings.id }).from(meetings).where(gt(meetings.endsAt, now))),
      ),
    );

  const joinBy = new Date(now.getTime() + config.BOT_JOIN_EARLY_S * 1000);

  const due = await db
    .select({ id: meetings.id, meetingUrl: meetings.meetingUrl, startsAt: meetings.startsAt, endsAt: meetings.endsAt })
    .from(meetings)
    .leftJoin(botSessions, eq(botSessions.meetingId, meetings.id))
    .where(
      and(
        eq(meetings.recordEnabled, true),
        eq(meetings.cancelled, false),
        isNull(meetings.deletedAt),
        eq(meetings.platform, "google_meet"),
        or(lte(meetings.startsAt, joinBy), isNotNull(meetings.botRequestedAt)),
        gt(meetings.endsAt, now),
        isNull(botSessions.id),
      ),
    );

  // The same call is often on several calendars (yours and a colleague's, or two of
  // your accounts). Send one bot per call. Links are reused (recurring meetings,
  // personal rooms), so a bot counts only while it's in or heading to the call, or if
  // it was in the call during this meeting's time.
  const recent = await db
    .select({
      url: meetings.meetingUrl,
      status: botSessions.status,
      joinedAt: botSessions.joinedAt,
      leftAt: botSessions.leftAt,
    })
    .from(botSessions)
    .innerJoin(meetings, eq(meetings.id, botSessions.meetingId))
    .where(gt(botSessions.createdAt, new Date(now.getTime() - RECENT_MS)));
  const covered = (m: (typeof due)[number]) =>
    recent.some(
      (r) =>
        meetCode(r.url) === meetCode(m.meetingUrl) &&
        ((ACTIVE as readonly string[]).includes(r.status) ||
          (RECORDED.includes(r.status) &&
            r.joinedAt !== null &&
            r.joinedAt < m.endsAt &&
            (r.leftAt ?? now) > m.startsAt)),
    );

  for (const m of due) {
    if (covered(m)) continue; // checked again next tick
    recent.push({ url: m.meetingUrl, status: "scheduled", joinedAt: null, leftAt: null });
    const [session] = await db
      .insert(botSessions)
      .values({ meetingId: m.id })
      .onConflictDoNothing({ target: botSessions.meetingId })
      .returning({ id: botSessions.id });
    if (!session) continue; // another scheduler got there first
    await joinQueue.add("join", { botSessionId: session.id }, { jobId: session.id, attempts: 1 });
    console.log(`Scheduled bot ${session.id} for meeting ${m.id}`);
  }
  return due.length;
}

export async function botNameFor(meetingId: string) {
  const [row] = await db
    .select({ name: users.name })
    .from(meetings)
    .innerJoin(users, eq(users.id, meetings.userId))
    .where(eq(meetings.id, meetingId));
  const first = row?.name?.split(" ")[0];
  return first ? `Notetaker for ${first}` : "MinuteFlow Notetaker";
}
