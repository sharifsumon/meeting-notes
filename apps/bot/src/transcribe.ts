import { readFile } from "node:fs/promises";
import path from "node:path";
import { botSessions, transcripts, type SpeakerTurn, type TranscriptSegment } from "@minuteflow/db";
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
    utterances?: { start: number; end: number; transcript: string; speaker?: number; confidence?: number }[];
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

type Attempt = {
  language: string | null;
  languageConfidence: number;
  confidence: number;
  segments: TranscriptSegment[];
  /** Deepgram's confidence for each of `segments`. */
  segmentConfidence: number[];
};

function attempt(body: DeepgramResponse, language?: string): Attempt {
  const channel = body.results?.channels?.[0];
  const segments = deepgramSegments(body);
  const spoken = (body.results?.utterances ?? []).filter((u) => u.transcript.trim());
  return {
    language: language ?? channel?.detected_language ?? null,
    languageConfidence: channel?.language_confidence ?? 0,
    // An empty transcript says nothing about the language, so it never wins.
    confidence: segments.length ? (channel?.alternatives?.[0]?.confidence ?? 0) : 0,
    segments,
    segmentConfidence: spoken.map((u) => u.confidence ?? 0),
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

/** How much more confident another language's transcript of a stretch must be to replace it. */
export const SWITCH_MARGIN = 0.15;
// A language counts as spoken in the call once it covers this share of the lines.
const MIXED_SHARE = 0.1;

/**
 * Builds one transcript for a call that switches between languages (Bangla and English, say).
 * Deepgram transcribes a whole file in one language, so the best attempt keeps its speakers and
 * timing, and each line is swapped for another language's transcript of the same stretch when
 * that one is clearly more confident. The language reads "bn,en" when both are spoken.
 */
export function mergeAttempts(attempts: Attempt[]): { language: string | null; segments: TranscriptSegment[] } {
  const base = bestAttempt(attempts);
  const others = attempts.filter((a) => a !== base && a.segments.length);
  const lineLanguage: (string | null)[] = [];
  const segments = base.segments.map((seg, i) => {
    let best = { language: base.language, confidence: base.segmentConfidence[i] ?? 0, text: seg.text };
    for (const other of others) {
      // Lines of the other transcript whose middle falls inside this one.
      const inside = other.segments
        .map((o, j) => ({ o, confidence: other.segmentConfidence[j] ?? 0 }))
        .filter(({ o }) => {
          const mid = (o.startMs + o.endMs) / 2;
          return mid >= seg.startMs && mid <= seg.endMs;
        });
      if (!inside.length) continue;
      const ms = inside.reduce((n, { o }) => n + Math.max(1, o.endMs - o.startMs), 0);
      const confidence = inside.reduce((n, { o, confidence: c }) => n + c * Math.max(1, o.endMs - o.startMs), 0) / ms;
      if (confidence > best.confidence + SWITCH_MARGIN) {
        best = { language: other.language, confidence, text: inside.map(({ o }) => o.text).join(" ") };
      }
    }
    lineLanguage.push(best.language);
    return best.text === seg.text ? seg : { ...seg, text: best.text };
  });

  const counts = new Map<string, number>();
  for (const l of lineLanguage) if (l) counts.set(l.split("-")[0]!, (counts.get(l.split("-")[0]!) ?? 0) + 1);
  const spoken = [...counts]
    .filter(([, n]) => n / Math.max(1, segments.length) >= MIXED_SHARE)
    .sort((a, b) => b[1] - a[1])
    .map(([l]) => l);
  return { language: spoken.length > 1 ? spoken.join(",") : base.language, segments };
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
        // Calls in Bangla often switch to English, so English gets its own pass to merge from.
        const english = auto.language?.startsWith("en") ? [] : ["en"];
        for (const language of [...extraLanguages, ...english]) attempts.push(await listen(audio, mimeType, language));
      }
      const merged = mergeAttempts(attempts);
      console.log(
        `[deepgram] ${attempts.map((a) => `${a.language ?? "?"}=${a.confidence.toFixed(2)}`).join(", ")} → ${merged.language ?? "unknown"}`,
      );
      return merged;
    },
  };
}

/**
 * Swaps Deepgram's "Speaker N" labels for the names Meet's captions showed speaking at the same
 * time. Each label gets the name it overlaps most, one name per label; labels with no clear
 * match stay numbered.
 */
export function nameSpeakers(segments: TranscriptSegment[], timeline: SpeakerTurn[]): TranscriptSegment[] {
  if (!timeline.length) return segments;
  const overlap = new Map<string, Map<string, number>>();
  for (const seg of segments) {
    for (const turn of timeline) {
      const ms = Math.min(seg.endMs, turn.endMs) - Math.max(seg.startMs, turn.startMs);
      if (ms <= 0) continue;
      const byName = overlap.get(seg.speaker) ?? new Map<string, number>();
      byName.set(turn.name, (byName.get(turn.name) ?? 0) + ms);
      overlap.set(seg.speaker, byName);
    }
  }
  const pairs = [...overlap].flatMap(([label, byName]) => {
    const total = [...byName.values()].reduce((a, b) => a + b, 0);
    return [...byName].map(([name, ms]) => ({ label, name, ms, share: ms / total }));
  });
  pairs.sort((a, b) => b.ms - a.ms);
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const p of pairs) {
    // A name has to account for most of what the captions showed while this label spoke.
    if (names.has(p.label) || used.has(p.name) || p.share < 0.5) continue;
    names.set(p.label, p.name);
    used.add(p.name);
  }
  return segments.map((seg) => ({ ...seg, speaker: names.get(seg.speaker) ?? seg.speaker }));
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
    .select({ id: botSessions.id, key: botSessions.recordingKey, timeline: botSessions.speakerTimeline })
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
      const result = await provider.transcribe(audio, "audio/webm");
      const { language } = result;
      const segments = nameSpeakers(result.segments, s.timeline);
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
