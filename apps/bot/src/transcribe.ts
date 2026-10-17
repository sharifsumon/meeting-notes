import { readFile } from "node:fs/promises";
import path from "node:path";
import { botSessions, transcripts, type SpeakerTurn, type TranscriptSegment } from "@minuteflow/db";
import { and, eq, inArray, isNotNull, isNull, like, not, or } from "drizzle-orm";
import { config } from "./config";
import { db } from "./db";
import { fullName, isBotName } from "./meet/names";
import { gemini } from "./gemini";
import { assignSpeakers, groqWhisper, scriptLanguage, type WhisperSegment } from "./whisper";

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
};

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

/** Writes the words of a call without telling speakers apart; Deepgram's diarization adds who spoke. */
export type LineTranscriber = { readonly name: string; transcribe(audio: Buffer, language?: string): Promise<WhisperSegment[]> };

export function deepgram(apiKey: string, extraLanguages: string[] = [], bangla?: LineTranscriber): TranscriptionProvider {
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
      if (bangla && needsExtraLanguages(auto)) {
        // Deepgram transcribes Bangla poorly and can't switch languages mid-call; Whisper writes the
        // words and Deepgram says who spoke them.
        try {
          // Deepgram doesn't know Bangla, so it guesses a neighbour (often Hindi). Anything but English means Bangla here.
          const pin = auto.language?.startsWith("en") ? undefined : "bn";
          const lines = await bangla.transcribe(audio, pin);
          if (lines.length) {
            const segments = assignSpeakers(lines, auto.segments);
            const language = scriptLanguage(segments) ?? auto.language;
            console.log(`[transcribe] ${bangla.name}: ${segments.length} lines, ${language ?? "unknown"} (Deepgram guessed ${auto.language ?? "?"})`);
            return { language, segments };
          }
        } catch (err) {
          console.error(`[transcribe] ${bangla.name} failed, using Deepgram only: ${err}`);
        }
      }
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

/**
 * Without captions, a call where Meet listed one other person and the transcript heard one
 * voice can still be named.
 */
export function nameOnlySpeaker(segments: TranscriptSegment[], participants: string[]): TranscriptSegment[] {
  const labels = new Set(segments.map((s) => s.speaker));
  if (participants.length !== 1 || labels.size !== 1 || !/^Speaker \d+$/.test([...labels][0]!)) return segments;
  return segments.map((s) => ({ ...s, speaker: participants[0]! }));
}

/** Puts people's names on a transcript's numbered speakers, from captions and Meet's People list. */
export function nameTranscript(segments: TranscriptSegment[], timeline: SpeakerTurn[], participants: string[]) {
  const people = participants.filter((n) => !isBotName(n, [config.BOT_ACCOUNT_NAME]));
  return nameOnlySpeaker(nameSpeakers(segments, timeline), people).map((seg) => ({ ...seg, speaker: fullName(seg.speaker, people) }));
}

/** The configured provider, or null when no transcription key is set. */
export function transcriptionProvider(): TranscriptionProvider | null {
  if (!config.DEEPGRAM_API_KEY) return null;
  const extra = config.TRANSCRIBE_EXTRA_LANGUAGES.split(",").map((l) => l.trim()).filter(Boolean);
  return deepgram(config.DEEPGRAM_API_KEY, extra, banglaTranscriber(config.TRANSCRIBE_BANGLA_PROVIDER));
}

/** The transcriber for calls that aren't clearly English; undefined means Deepgram's own Bangla. */
export function banglaTranscriber(choice: "deepgram" | "whisper" | "gemini"): LineTranscriber | undefined {
  if (choice === "whisper") {
    if (config.GROQ_API_KEY) return groqWhisper(config.GROQ_API_KEY, config.GROQ_WHISPER_MODEL);
    console.error("[transcribe] TRANSCRIBE_BANGLA_PROVIDER=whisper needs GROQ_API_KEY; using Deepgram");
  }
  if (choice === "gemini") {
    if (config.GEMINI_API_KEY) return gemini(config.GEMINI_API_KEY, config.GEMINI_MODEL);
    console.error("[transcribe] TRANSCRIBE_BANGLA_PROVIDER=gemini needs GEMINI_API_KEY; using Deepgram");
  }
  return undefined;
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
    .select({
      id: botSessions.id,
      key: botSessions.recordingKey,
      timeline: botSessions.speakerTimeline,
      participants: botSessions.participants,
    })
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
      const segments = nameTranscript(result.segments, s.timeline, s.participants);
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
