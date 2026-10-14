import { botSessions, meetings, users } from "@minuteflow/db";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { config } from "./config";
import { db } from "./db";
import { joinQueue } from "./queue";

/**
 * Finds meetings marked for recording that are about to start and have no bot yet,
 * creates a bot session for each and queues the join. Safe to run repeatedly.
 */
export async function scheduleDueMeetings(now = new Date()) {
  const joinBy = new Date(now.getTime() + config.BOT_JOIN_EARLY_S * 1000);

  const due = await db
    .select({ id: meetings.id })
    .from(meetings)
    .leftJoin(botSessions, eq(botSessions.meetingId, meetings.id))
    .where(
      and(
        eq(meetings.recordEnabled, true),
        eq(meetings.cancelled, false),
        eq(meetings.platform, "google_meet"),
        lte(meetings.startsAt, joinBy),
        gt(meetings.endsAt, now),
        isNull(botSessions.id),
      ),
    );

  for (const m of due) {
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
