import { botSessions, meetings } from "@minuteflow/db";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { JoinFailed, recordMeet } from "./meet/join";
import { botNameFor } from "./scheduler";
import { openRecording } from "./storage";

// Stay at most this long past the scheduled end if people are still talking.
const OVERRUN_MS = 60 * 60_000;

/** Runs one bot session: join the meeting, record it, store the audio. */
export async function runBotSession(botSessionId: string) {
  const [row] = await db
    .select({ session: botSessions, meeting: meetings })
    .from(botSessions)
    .innerJoin(meetings, eq(meetings.id, botSessions.meetingId))
    .where(eq(botSessions.id, botSessionId));
  if (!row) throw new Error(`Bot session ${botSessionId} not found`);
  const { session, meeting } = row;
  if (session.status !== "scheduled") return; // already ran or was cancelled
  if (!meeting.meetingUrl || !meeting.recordEnabled || meeting.cancelled) {
    await setStatus(botSessionId, { status: "cancelled" });
    return;
  }

  const log = (msg: string) => console.log(`[bot ${botSessionId}] ${msg}`);
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
      log,
    });
    await writes;
    log(`Recorded ${recording.bytes} bytes (${result.reason})`);
    await setStatus(botSessionId, {
      // Transcription picks up sessions in "processing" (next milestone).
      status: recording.bytes > 0 ? "processing" : "failed",
      joinedAt: result.joinedAt,
      leftAt: result.leftAt,
      error: recording.bytes > 0 ? null : "No audio was captured",
    });
  } catch (err) {
    const message = err instanceof JoinFailed ? err.message : `Bot crashed: ${String(err)}`;
    log(message);
    await setStatus(botSessionId, { status: "failed", error: message, leftAt: new Date() });
  } finally {
    await writes.catch(() => {});
    await recording.close();
  }
}

function setStatus(id: string, values: Partial<typeof botSessions.$inferInsert>) {
  return db.update(botSessions).set(values).where(eq(botSessions.id, id));
}
