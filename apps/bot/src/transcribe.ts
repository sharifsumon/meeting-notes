import { readFile } from "node:fs/promises";
import path from "node:path";
import { botSessions, transcripts, type TranscriptSegment } from "@minuteflow/db";
import { and, eq, inArray, isNotNull, isNull, like, not, or } from "drizzle-orm";
import { config } from "./config";
import { db } from "./db";

/** Turns a recording into speaker-labelled segments. Swap the implementation to change services. */
export interface TranscriptionProvider {
  readonly name: string;
  transcribe(audio: Buffer, mimeType: string): Promise<{ language: string | null; segments: TranscriptSegment[] }>;
}

type DeepgramResponse = {
  results?: {
    channels?: { detected_language?: string; language_confidence?: number; alternatives?: { confidence?: number }[] }[];
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

type Attempt = { language: string | null; languageConfidence: number; confidence: number; segments: TranscriptSegment[] };

function attempt(body: DeepgramResponse, language?: string): Attempt {
  const channel = body.results?.channels?.[0];
  const segments = deepgramSegments(body);
  return {
    language: language ?? channel?.detected_language ?? null,
    languageConfidence: channel?.language_confidence ?? 0,
    // An empty transcript says nothing about the language, so it never wins.
    confidence: segments.length ? (channel?.alternatives?.[0]?.confidence ?? 0) : 0,
    segments,
  };
}

/** Auto-detection is trusted for confidently detected English; anything else is checked against the extra languages. */
export const TRUSTED_DETECTION = 0.85;

/**
 * Picks the transcript to keep. Deepgram's detection only knows ~35 languages (not Bangla), so audio in
 * another language comes back as its closest guess, usually with a poor transcript. Each extra language
 * is transcribed explicitly and the most confident transcript wins.
 */
export function needsExtraLanguages(auto: Attempt) {
  return !(auto.language?.startsWith("en") && auto.languageConfidence >= TRUSTED_DETECTION);
}

export function bestAttempt(attempts: Attempt[]): Attempt {
  return attempts.reduce((best, a) => (a.confidence > best.confidence ? a : best));
}

export function deepgram(apiKey: string, extraLanguages: string[] = []): TranscriptionProvider {
  async function listen(audio: Buffer, mimeType: string, language?: string) {
    const url = new URL("https://api.deepgram.com/v1/listen");
    for (const [k, v] of Object.entries({
      model: "nova-3",
      smart_format: "true",
      punctuate: "true",
      diarize: "true",
      utterances: "true",
      ...(language ? { language } : { detect_language: "true" }),
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
    return attempt((await res.json()) as DeepgramResponse, language);
  }

  return {
    name: "Deepgram",
    async transcribe(audio, mimeType) {
      const auto = await listen(audio, mimeType);
      const attempts = [auto];
      if (needsExtraLanguages(auto)) {
        for (const language of extraLanguages) attempts.push(await listen(audio, mimeType, language));
      }
      const best = bestAttempt(attempts);
      console.log(
        `[deepgram] ${attempts.map((a) => `${a.language ?? "?"}=${a.confidence.toFixed(2)}`).join(", ")} → ${best.language ?? "unknown"}`,
      );
      return { language: best.language, segments: best.segments };
    },
  };
}

/** The configured provider, or null when no transcription key is set. */
export function transcriptionProvider(): TranscriptionProvider | null {
  if (!config.DEEPGRAM_API_KEY) return null;
  const extra = config.TRANSCRIBE_EXTRA_LANGUAGES.split(",").map((l) => l.trim()).filter(Boolean);
  return deepgram(config.DEEPGRAM_API_KEY, extra);
}

const FAILED_PREFIX = "Transcription failed";
const attempts = new Map<string, number>();
const MAX_ATTEMPTS = 3;

/** Transcribes recorded sessions that don't have a transcript yet, one at a time. */
export async function transcribePending(provider: TranscriptionProvider) {
  // Sessions transcribed before this step marked them done (the summary step does that when it's on).
  if (!config.GROQ_API_KEY) {
    await db
      .update(botSessions)
      .set({ status: "completed" })
      .where(
        and(
          eq(botSessions.status, "processing"),
          inArray(botSessions.id, db.select({ id: transcripts.botSessionId }).from(transcripts)),
        ),
      );
  }

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
      // With AI notes on, the summary step marks the session done; empty transcripts have nothing to summarize.
      if (!config.GROQ_API_KEY || segments.length === 0) {
        await db.update(botSessions).set({ status: "completed" }).where(eq(botSessions.id, s.id));
      }
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
