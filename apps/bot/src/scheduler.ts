import { botSessions, meetings, users } from "@minuteflow/db";
import { and, eq, gt, inArray, isNotNull, isNull, lte, notInArray, or } from "drizzle-orm";
import { config } from "./config";
import { db } from "./db";
import { meetCode } from "./meet/links";
import { joinQueue, PRIORITY_CALENDAR, PRIORITY_SENT_NOW } from "./queue";
import { type RecordedSession, sharedSessionFor } from "./shared";

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
    .select({
      id: meetings.id,
      meetingUrl: meetings.meetingUrl,
      startsAt: meetings.startsAt,
      endsAt: meetings.endsAt,
      botRequestedAt: meetings.botRequestedAt,
    })
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
    // A bot of its own replaces a recording shared from someone else's (one that never got in).
    await db.update(meetings).set({ sharedSessionId: null }).where(eq(meetings.id, m.id));
    await joinQueue.add(
      "join",
      { botSessionId: session.id, meetingId: m.id },
      { jobId: session.id, attempts: 1, priority: m.botRequestedAt ? PRIORITY_SENT_NOW : PRIORITY_CALENDAR },
    );
    console.log(`Scheduled bot ${session.id} for meeting ${m.id}`);
  }
  await promoteSentNow();
  return due.length;
}

/** A calendar call that's already queued moves to the front once someone presses "Send bot now". */
async function promoteSentNow() {
  const queued = await db
    .select({ id: botSessions.id })
    .from(botSessions)
    .innerJoin(meetings, eq(meetings.id, botSessions.meetingId))
    .where(and(eq(botSessions.status, "scheduled"), isNotNull(meetings.botRequestedAt)));
  for (const { id } of queued) {
    const job = await joinQueue.getJob(id);
    if (!job || job.opts.priority === PRIORITY_SENT_NOW) continue;
    if (!["waiting", "prioritized"].includes(await job.getState())) continue;
    await job.changePriority({ priority: PRIORITY_SENT_NOW });
    console.log(`Moved bot ${id} to the front of the queue`);
  }
}

// How far back meetings are matched to someone else's recording.
const SHARE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * When a call is on several MinuteFlow users' calendars, only one bot joins. Everyone else's copy
 * of the meeting is pointed at that bot's recording, so they see its status, transcript and notes.
 */
export async function linkSharedMeetings(now = new Date()) {
  const since = new Date(now.getTime() - SHARE_LOOKBACK_MS);
  const own = db.select({ id: botSessions.meetingId }).from(botSessions);
  const unlinked = await db
    .select({ id: meetings.id, url: meetings.meetingUrl, startsAt: meetings.startsAt, endsAt: meetings.endsAt })
    .from(meetings)
    .where(
      and(
        eq(meetings.platform, "google_meet"),
        eq(meetings.cancelled, false),
        isNull(meetings.deletedAt),
        isNull(meetings.sharedSessionId),
        lte(meetings.startsAt, now),
        gt(meetings.endsAt, since),
        notInArray(meetings.id, own),
      ),
    );
  if (!unlinked.length) return;

  const sessions = (
    await db
      .select({ id: botSessions.id, url: meetings.meetingUrl, joinedAt: botSessions.joinedAt, leftAt: botSessions.leftAt })
      .from(botSessions)
      .innerJoin(meetings, eq(meetings.id, botSessions.meetingId))
      .where(and(isNotNull(botSessions.joinedAt), gt(botSessions.createdAt, new Date(since.getTime() - RECENT_MS))))
  ).filter((s): s is RecordedSession => s.joinedAt !== null);

  for (const m of unlinked) {
    const shared = sharedSessionFor(m, sessions, now);
    if (!shared) continue;
    await db.update(meetings).set({ sharedSessionId: shared }).where(eq(meetings.id, m.id));
    console.log(`Meeting ${m.id} shares bot ${shared}'s recording`);
  }
}

/**
 * Drops queued joins whose bot session is gone because the user deleted the meeting. (The worker
 * would skip them anyway; this keeps them from holding a place in the queue.)
 */
export async function removeDeletedJobs() {
  const jobs = await joinQueue.getJobs(["waiting", "delayed", "prioritized", "paused"]);
  if (!jobs.length) return;
  const ids = jobs.map((j) => j.data.botSessionId);
  const live = new Set(
    (await db.select({ id: botSessions.id }).from(botSessions).where(inArray(botSessions.id, ids))).map((r) => r.id),
  );
  const byMeeting = new Map<string, number>();
  for (const job of jobs) {
    if (live.has(job.data.botSessionId)) continue;
    await job.remove().catch((err) => console.error(`Couldn't remove queued job ${job.id}:`, err));
    const meeting = job.data.meetingId ?? `unknown (bot ${job.data.botSessionId})`;
    byMeeting.set(meeting, (byMeeting.get(meeting) ?? 0) + 1);
  }
  for (const [meeting, n] of byMeeting) console.log(`Removed ${n} queued jobs for meeting ${meeting}`);
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
