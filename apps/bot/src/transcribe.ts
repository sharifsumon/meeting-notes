import { readFile } from "node:fs/promises";
import path from "node:path";
import { botSessions, transcripts, type TranscriptSegment } from "@minuteflow/db";
import { and, eq, isNotNull, isNull, not, like, or } from "drizzle-orm";
import { config } from "./config";
import { db } from "./db";

/** Turns a recording into speaker-labelled segments. Swap the implementation to change services. */
export interface TranscriptionProvider {
  readonly name: string;
  transcribe(audio: Buffer, mimeType: string): Promise<{ language: string | null; segments: TranscriptSegment[] }>;
}

type DeepgramResponse = {
  results?: {
    channels?: { detected_language?: string }[];
    utterances?: { start: number; end: number; transcript: string; speaker?: number }[];
  };
};

/** Parses Deepgram's pre-recorded response (with utterances and diarization) into our segments. */
export function deepgramSegments(body: DeepgramResponse): TranscriptSegment[] {
  return (body.results?.utterances ?? [])
    .filter((u) => u.transcript.trim())
    .map((u) => ({
      speaker: `Speaker ${(u.speaker ?? 0) + 1}`,
      startMs: Math.round(u.start * 1000),
      endMs: Math.round(u.end * 1000),
      text: u.transcript.trim(),
    }));
}

export function deepgram(apiKey: string): TranscriptionProvider {
  return {
    name: "Deepgram",
    async transcribe(audio, mimeType) {
      const url = new URL("https://api.deepgram.com/v1/listen");
      for (const [k, v] of Object.entries({
        model: "nova-3",
        smart_format: "true",
        punctuate: "true",
        diarize: "true",
        utterances: "true",
        detect_language: "true",
      })) {
        url.searchParams.set(k, v);
      }
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Token ${apiKey}`, "Content-Type": mimeType },
        body: new Uint8Array(audio),
        signal: AbortSignal.timeout(15 * 60_000),
      });
      if (!res.ok) throw new Error(`Deepgram returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as DeepgramResponse;
      return { language: body.results?.channels?.[0]?.detected_language ?? null, segments: deepgramSegments(body) };
    },
  };
}

/** The configured provider, or null when no transcription key is set. */
export function transcriptionProvider(): TranscriptionProvider | null {
  return config.DEEPGRAM_API_KEY ? deepgram(config.DEEPGRAM_API_KEY) : null;
}

const FAILED_PREFIX = "Transcription failed";
const attempts = new Map<string, number>();
const MAX_ATTEMPTS = 3;

/** Transcribes recorded sessions that don't have a transcript yet, one at a time. */
export async function transcribePending(provider: TranscriptionProvider) {
  const pending = await db
    .select({ id: botSessions.id, key: botSessions.recordingKey })
    .from(botSessions)
    .leftJoin(transcripts, eq(transcripts.botSessionId, botSessions.id))
    .where(
      and(
        eq(botSessions.status, "processing"),
        isNotNull(botSessions.recordingKey),
        isNull(transcripts.id),
        or(isNull(botSessions.error), not(like(botSessions.error, `${FAILED_PREFIX}%`))),
      ),
    )
    .limit(5);

  for (const s of pending) {
    const log = (msg: string) => console.log(`[transcribe ${s.id}] ${msg}`);
    try {
      const audio = await readFile(path.join(config.STORAGE_DIR, s.key!));
      log(`Sending ${audio.length} bytes to ${provider.name}`);
      const { language, segments } = await provider.transcribe(audio, "audio/webm");
      await db.insert(transcripts).values({ botSessionId: s.id, language, segments }).onConflictDoNothing();
      log(`Saved ${segments.length} segments`);
      attempts.delete(s.id);
    } catch (err) {
      const n = (attempts.get(s.id) ?? 0) + 1;
      attempts.set(s.id, n);
      log(`Attempt ${n} failed: ${err}`);
      if (n >= MAX_ATTEMPTS) {
        await db
          .update(botSessions)
          .set({ error: `${FAILED_PREFIX}: ${String(err).slice(0, 300)}` })
          .where(eq(botSessions.id, s.id));
        attempts.delete(s.id);
      }
    }
  }
}
