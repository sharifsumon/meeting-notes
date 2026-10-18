/**
 * Re-transcribes an existing recording. With --dry-run it only prints the lines, to compare
 * providers on a real call. With --save it replaces the call's transcript and deletes its notes,
 * so the running bot writes fresh notes from the new transcript.
 *
 *   pnpm --filter @minuteflow/bot retranscribe <botSessionId> --provider deepgram|whisper|gemini --dry-run|--save
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { botSessions, notes, transcripts } from "@minuteflow/db";
import { eq } from "drizzle-orm";
import { config } from "./config";
import { db } from "./db";
import { banglaTranscriber, deepgram, nameTranscript } from "./transcribe";

const [id, ...flags] = process.argv.slice(2);
const choice = flags[flags.indexOf("--provider") + 1] ?? "deepgram";
const save = flags.includes("--save");
if (!id || !["deepgram", "whisper", "gemini"].includes(choice) || save === flags.includes("--dry-run")) {
  console.error("Usage: retranscribe <botSessionId> --provider deepgram|whisper|gemini --dry-run|--save");
  process.exit(1);
}
if (!config.DEEPGRAM_API_KEY) throw new Error("DEEPGRAM_API_KEY is needed (it finds the speakers)");

const [session] = await db
  .select({
    key: botSessions.recordingKey,
    meetingId: botSessions.meetingId,
    timeline: botSessions.speakerTimeline,
    participants: botSessions.participants,
  })
  .from(botSessions)
  .where(eq(botSessions.id, id));
if (!session?.key) throw new Error(`No recording for bot session ${id}`);

const audio = await readFile(path.join(config.STORAGE_DIR, session.key));
const extra = config.TRANSCRIBE_EXTRA_LANGUAGES.split(",")
  .map((l) => l.trim())
  .filter(Boolean);
const provider = deepgram(config.DEEPGRAM_API_KEY, extra, banglaTranscriber(choice as "deepgram" | "whisper" | "gemini"));
const result = await provider.transcribe(audio, "audio/webm");
const segments = nameTranscript(result.segments, session.timeline, session.participants);

console.log(`\nProvider: ${choice} · language: ${result.language ?? "unknown"} · ${segments.length} lines${save ? "" : " (not saved)"}\n`);
for (const s of segments) {
  const t = Math.floor(s.startMs / 1000);
  console.log(`[${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}] ${s.speaker}: ${s.text}`);
}
if (save) {
  if (!segments.length) throw new Error("The new transcript is empty; keeping the old one");
  await db.transaction(async (tx) => {
    await tx
      .insert(transcripts)
      .values({ botSessionId: id, language: result.language, segments })
      .onConflictDoUpdate({ target: transcripts.botSessionId, set: { language: result.language, segments } });
    await tx.delete(notes).where(eq(notes.meetingId, session.meetingId));
    // Clears a "Summary failed" error so the summary step tries again.
    await tx.update(botSessions).set({ status: "processing", error: null }).where(eq(botSessions.id, id));
  });
  console.log("\nSaved. The bot writes new notes for this call within a minute.");
}
process.exit(0);
