/**
 * Prints how a provider transcribes an existing recording, to compare providers on a real call.
 * Read-only: nothing is saved.
 *
 *   pnpm --filter @minuteflow/bot retranscribe <botSessionId> --provider deepgram|whisper|gemini --dry-run
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { botSessions } from "@minuteflow/db";
import { eq } from "drizzle-orm";
import { config } from "./config";
import { db } from "./db";
import { banglaTranscriber, deepgram, nameTranscript } from "./transcribe";

const [id, ...flags] = process.argv.slice(2);
const choice = flags[flags.indexOf("--provider") + 1] ?? "deepgram";
if (!id || !["deepgram", "whisper", "gemini"].includes(choice) || !flags.includes("--dry-run")) {
  console.error("Usage: retranscribe <botSessionId> --provider deepgram|whisper|gemini --dry-run");
  process.exit(1);
}
if (!config.DEEPGRAM_API_KEY) throw new Error("DEEPGRAM_API_KEY is needed (it finds the speakers)");

const [session] = await db
  .select({ key: botSessions.recordingKey, timeline: botSessions.speakerTimeline, participants: botSessions.participants })
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

console.log(`\nProvider: ${choice} · language: ${result.language ?? "unknown"} · ${segments.length} lines (not saved)\n`);
for (const s of segments) {
  const t = Math.floor(s.startMs / 1000);
  console.log(`[${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}] ${s.speaker}: ${s.text}`);
}
process.exit(0);
