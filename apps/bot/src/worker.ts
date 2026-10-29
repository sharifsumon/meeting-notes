import { AD_HOC_MEETING_TITLE, botSessions, meetings, users } from "@minuteflow/db";
import { and, eq, gt, isNotNull, lte } from "drizzle-orm";
import { db } from "./db";
import { JoinFailed, recordMeet } from "./meet/join";
import { meetCode } from "./meet/links";
import { botNameFor } from "./scheduler";
import { sentNowCallWaiting } from "./queue";
import { openRecording } from "./storage";

// Stay at most this long past the scheduled end if people are still talking.
const OVERRUN_MS = 60 * 60_000;
// Calls often run past their calendar slot, so a bot that waited in the queue still goes this long after it.
const LATE_JOIN_MS = 30 * 60_000;
// Someone who sent the bot themselves is in the call to let it in, but may take a while to notice.
const SENT_ADMIT_MS = 15 * 60_000;

/**
 * Everyone this call belongs to: the same event is often on several MinuteFlow calendars
 * (colleagues, or one person's two accounts). The bot stays while any of them is in the call.
 */
async function ownerNamesFor(meeting: typeof meetings.$inferSelect, fallback: string | null) {
  const code = meetCode(meeting.meetingUrl);
  const now = new Date();
  const rows = code
    ? await db
        .select({ name: users.name, url: meetings.meetingUrl })
        .from(meetings)
        .innerJoin(users, eq(users.id, meetings.userId))
        .where(
          and(
            isNotNull(meetings.meetingUrl),
            eq(meetings.cancelled, false),
            lte(meetings.startsAt, new Date(now.getTime() + 60 * 60_000)),
            gt(meetings.endsAt, now),
          ),
        )
    : [];
  const names = rows.filter((r) => meetCode(r.url) === code).map((r) => r.name);
  return [...new Set([fallback, ...names].filter((n): n is string => Boolean(n?.trim())))];
}

/** Runs one bot session: join the meeting, record it, store the audio. */
export async function runBotSession(botSessionId: string) {
  const [row] = await db
    .select({ session: botSessions, meeting: meetings, ownerName: users.name })
    .from(botSessions)
    .innerJoin(meetings, eq(meetings.id, botSessions.meetingId))
    .innerJoin(users, eq(users.id, meetings.userId))
    .where(eq(botSessions.id, botSessionId));
  if (!row) return console.log(`Bot session ${botSessionId} no longer exists (meeting deleted); skipping`);
  const { session, meeting, ownerName } = row;
  if (session.status !== "scheduled") return; // already ran or was cancelled
  if (!meeting.meetingUrl || !meeting.recordEnabled || meeting.cancelled || meeting.deletedAt) {
    await setStatus(botSessionId, { status: "cancelled" });
    return;
  }

  // A call that overlaps others waits in the queue; well past its end there's nothing left to join.
  if (meeting.endsAt.getTime() + LATE_JOIN_MS <= Date.now()) {
    await setStatus(botSessionId, { status: "cancelled", error: "Not recorded: the notetaker was busy with another call" });
    return;
  }

  const log = (msg: string) => console.log(`[bot ${botSessionId}] ${msg}`);
  // "Send bot now", or a pasted link (a meeting with no calendar behind it).
  const sentByUser = Boolean(meeting.botRequestedAt) || !meeting.calendarId;
  const recording = await openRecording(meeting.userId, botSessionId);
  // Write chunks strictly in order.
  let writes = Promise.resolve();
  const onChunk = (b64: string) => (writes = writes.then(() => recording.write(b64)));

  await setStatus(botSessionId, { status: "joining", recordingKey: recording.key });
  try {
    const result = await recordMeet({
      url: meeting.meetingUrl,
      botName: await botNameFor(meeting.id),
      onChunk,
      leaveBy: new Date(meeting.endsAt.getTime() + OVERRUN_MS),
      // Follow the MinuteFlow users: leave shortly after the last of them does.
      ownerNames: await ownerNamesFor(meeting, ownerName),
      onWaitingRoom: () => setStatus(botSessionId, { status: "waiting_room" }),
      admitTimeoutMs: sentByUser ? SENT_ADMIT_MS : undefined,
      // A calendar call nobody is letting the bot into makes way for a call someone sent the bot to.
      giveWay: sentByUser ? undefined : sentNowCallWaiting,
      onAdmitted: (joinedAt) => setStatus(botSessionId, { status: "recording", joinedAt }),
      // A meeting sent by link gets the call's name from Meet.
      onTitle: (title) =>
        db
          .update(meetings)
          .set({ title })
          .where(and(eq(meetings.id, meeting.id), eq(meetings.title, AD_HOC_MEETING_TITLE))),
      log,
    });
    await writes;
    log(`Recorded ${recording.bytes} bytes (${result.reason})`);
    await setStatus(botSessionId, {
      // Transcription picks up sessions in "processing" (next milestone).
      status: recording.bytes > 0 ? "processing" : "failed",
      joinedAt: result.joinedAt,
      leftAt: result.leftAt,
      participants: result.participants,
      speakerTimeline: result.speakerTimeline,
      error: recording.bytes > 0 ? null : "No audio was captured",
    });
  } catch (err) {
    await writes.catch(() => {});
    const message = err instanceof JoinFailed ? err.message : `Bot crashed: ${String(err)}`;
    log(message);
    if (recording.bytes > 0) {
      // Stopped mid-call (a restart, or the browser died): keep what was recorded and transcribe it.
      log(`Keeping the ${recording.bytes} bytes recorded so far`);
      await setStatus(botSessionId, { status: "processing", error: null, leftAt: new Date() });
    } else {
      await setStatus(botSessionId, { status: "failed", error: message, leftAt: new Date() });
    }
  } finally {
    await writes.catch(() => {});
    await recording.close();
  }
}

function setStatus(id: string, values: Partial<typeof botSessions.$inferInsert>) {
  return db.update(botSessions).set(values).where(eq(botSessions.id, id));
}
