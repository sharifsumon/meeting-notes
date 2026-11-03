import { readFile } from "node:fs/promises";
import path from "node:path";
import { botSessions, meetings, notes, transcripts, users, type SpeakerTurn, type TranscriptSegment } from "@minuteflow/db";
import { and, eq, inArray, isNotNull, isNull, like, not, or } from "drizzle-orm";
import { config } from "./config";
import { db } from "./db";
import { fullName, isBotName } from "./meet/names";
import { gemini } from "./gemini";
import { notesOn } from "./summarize";
import { ownGeminiKey } from "./user-keys";
import { assignSpeakers, groqWhisper, scriptLanguage, type WhisperSegment } from "./whisper";

/** Turns a recording into speaker-labelled segments. Swap the implementation to change services. */
export interface TranscriptionProvider {
  readonly name: string;
  transcribe(audio: Buffer, mimeType: string): Promise<{ language: string | null; segments: TranscriptSegment[] }>;
}

type DeepgramResponse = {
  results?: {
    channels?: { detected_language?: string; language_confidence?: number; alternatives?: { confidence?: number }[] }[];
    utterances?: {
      start: number;
      end: number;
      transcript: string;
      speaker?: number;
      confidence?: number;
      words?: { word: string; punctuated_word?: string; start: number; end: number }[];
    }[];
  };
};

/** A word's timing, kept while naming speakers so a line can be split where the captions change speaker. Not saved. */
export type TimedWord = { text: string; startMs: number; endMs: number };
type TimedSegment = TranscriptSegment & { words?: TimedWord[] };

/** Parses Deepgram's pre-recorded response (with utterances and diarization) into our segments. */
export function deepgramSegments(body: DeepgramResponse): TimedSegment[] {
  return (body.results?.utterances ?? [])
    .filter((u) => u.transcript.trim())
    .map((u) => ({
      speaker: `Speaker ${(u.speaker ?? 0) + 1}`,
      startMs: Math.round(u.start * 1000),
      endMs: Math.round(u.end * 1000),
      text: u.transcript.trim(),
      words: u.words?.map((w) => ({
        text: w.punctuated_word ?? w.word,
        startMs: Math.round(w.start * 1000),
        endMs: Math.round(w.end * 1000),
      })),
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
      // Keeps our audio out of Deepgram's Model Improvement Program, so it isn't used to train their models.
      mip_opt_out: "true",
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
export function nameSpeakers(segments: TimedSegment[], timeline: SpeakerTurn[]): TranscriptSegment[] {
  if (!timeline.length) return segments.map(({ words: _words, ...line }) => line);
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
  // Diarization can hear two people as one voice and run a quick exchange into one line; the captions
  // name each stretch of words directly.
  return segments.flatMap((seg) => {
    const fallback = names.get(seg.speaker) ?? seg.speaker;
    const pieces = seg.words?.length ? splitByCaptions(seg.words, timeline) : [];
    if (pieces.length > 1) {
      return pieces.map((p) => ({
        speaker: p.name ?? fallback,
        startMs: p.words[0]!.startMs,
        endMs: p.words[p.words.length - 1]!.endMs,
        text: p.words.map((w) => w.text).join(" "),
      }));
    }
    const { words: _words, ...line } = seg;
    return [{ ...line, speaker: pieces[0]?.name ?? captionedName(seg, timeline) ?? fallback }];
  });
}

/** Fewer words than this between two speaker changes are caption jitter, not a turn. */
const MIN_PIECE_WORDS = 3;
/** A caption turn counts as still going until the next one starts, up to this long after it ends. */
const HOLD_MS = 10_000;
/** How far a speaker change can move to land on a pause, since caption timing is only roughly right. */
const SNAP_MS = 1_500;

/**
 * A person is speaking from the moment their caption starts until someone else's starts (Meet keeps
 * revising an earlier block after the next person begins, so its end time runs long). Turns can nest,
 * as when one person's block stays open around another's, so the latest-started turn wins.
 */
function speakerAt(timeline: SpeakerTurn[]) {
  const turns = [...timeline].sort((a, b) => a.startMs - b.startMs);
  const spans = turns.map((turn, i) => {
    const next = turns.slice(i + 1).find((t) => t.name !== turn.name);
    const held = next ? Math.min(next.startMs, turn.endMs + HOLD_MS) : turn.endMs;
    return { name: turn.name, startMs: turn.startMs, endMs: Math.max(turn.endMs, held) };
  });
  return (ms: number) => {
    let best: (typeof spans)[number] | undefined;
    for (const span of spans) if (ms >= span.startMs && ms <= span.endMs && (!best || span.startMs >= best.startMs)) best = span;
    return best?.name;
  };
}

/**
 * Groups a line's words by the caption speaker at each word's midpoint. Words no caption covers take
 * their neighbours' speaker; tiny groups join the one before them; and each change of speaker moves to
 * the longest pause near it, where one person stopped and the next began.
 */
export function splitByCaptions(words: TimedWord[], timeline: SpeakerTurn[]): { name?: string; words: TimedWord[] }[] {
  const nameAt = speakerAt(timeline);
  const groups: { name?: string; words: TimedWord[] }[] = [];
  for (const w of words) {
    const name = nameAt((w.startMs + w.endMs) / 2);
    const last = groups[groups.length - 1];
    if (last && (name === last.name || name === undefined)) last.words.push(w);
    else if (last && last.name === undefined) Object.assign(last, { name, words: [...last.words, w] });
    else groups.push({ name, words: [w] });
  }
  const merged: typeof groups = [];
  for (const g of groups) {
    const prev = merged[merged.length - 1];
    if (prev && (g.words.length < MIN_PIECE_WORDS || g.name === prev.name)) prev.words.push(...g.words);
    else merged.push({ ...g, words: [...g.words] });
  }
  // A short opening piece belongs with what follows.
  if (merged.length > 1 && merged[0]!.words.length < MIN_PIECE_WORDS) {
    const [first, second] = merged;
    merged.splice(0, 2, { name: second!.name, words: [...first!.words, ...second!.words] });
  }
  for (let i = 1; i < merged.length; i++) snapToPause(merged[i - 1]!.words, merged[i]!.words);
  return merged;
}

/** Moves the boundary between two pieces to the longest gap between words within SNAP_MS of it. */
function snapToPause(before: TimedWord[], after: TimedWord[]) {
  const all = [...before, ...after];
  const at = before.length;
  const gap = (j: number) => all[j]!.startMs - all[j - 1]!.endMs;
  const pivot = all[at]!.startMs;
  let best = at;
  for (let j = 1; j < all.length; j++) {
    if (Math.abs(all[j]!.startMs - pivot) > SNAP_MS) continue;
    // Each side keeps a real piece, so a pause can't swallow a whole turn.
    if (j < Math.min(MIN_PIECE_WORDS, at) || all.length - j < Math.min(MIN_PIECE_WORDS, all.length - at)) continue;
    if (gap(j) > gap(best) + 150 || (gap(j) === gap(best) && Math.abs(j - at) < Math.abs(best - at))) best = j;
  }
  if (best === at) return;
  before.splice(0, before.length, ...all.slice(0, best));
  after.splice(0, after.length, ...all.slice(best));
}

/**
 * The name the captions showed while this line was spoken. Turns can nest (an earlier speaker's
 * turn left open while someone else talked), so of the turns covering at least half of the line,
 * the shortest is the most specific one.
 */
export function captionedName(seg: TranscriptSegment, timeline: SpeakerTurn[]): string | undefined {
  const lineMs = Math.max(1, seg.endMs - seg.startMs);
  let best: SpeakerTurn | undefined;
  for (const turn of timeline) {
    const turnMs = Math.max(1, turn.endMs - turn.startMs);
    const ms = Math.min(seg.endMs, turn.endMs) - Math.max(seg.startMs, turn.startMs);
    if (ms < 0.5 * lineMs) continue;
    if (!best || turnMs < best.endMs - best.startMs) best = turn;
  }
  return best?.name;
}

/**
 * Without captions, a call where Meet listed one other person and the transcript heard one
 * voice can still be named.
 */
export function nameOnlySpeaker(segments: TranscriptSegment[], participants: string[]): TranscriptSegment[] {
  const labels = new Set(segments.map((s) => s.speaker));
  if (participants.length !== 1 || labels.size !== 1 || !/^Speaker \w+$/.test([...labels][0]!)) return segments;
  return segments.map((s) => ({ ...s, speaker: participants[0]! }));
}

/** Puts people's names on a transcript's numbered speakers, from captions and Meet's People list. */
export function nameTranscript(segments: TranscriptSegment[], timeline: SpeakerTurn[], participants: string[]) {
  const people = participants.filter((n) => !isBotName(n, [config.BOT_ACCOUNT_NAME]));
  return nameOnlySpeaker(nameSpeakers(segments, timeline), people).map((seg) => ({ ...seg, speaker: fullName(seg.speaker, people) }));
}

/**
 * Transcribes with one line transcriber that also tells voices apart (Gemini), numbering its voices
 * "Speaker N" for the captions to name. `fallback` takes over when it fails, e.g. out of quota.
 */
export function voicesOnly(lines: LineTranscriber, fallback?: TranscriptionProvider): TranscriptionProvider {
  return {
    name: fallback ? `${lines.name}, ${fallback.name} if it fails` : lines.name,
    async transcribe(audio, mimeType) {
      try {
        const segments = assignSpeakers(await lines.transcribe(audio), []);
        return { language: scriptLanguage(segments), segments };
      } catch (err) {
        if (!fallback) throw err;
        console.error(`[transcribe] ${lines.name} failed, using ${fallback.name}: ${err}`);
        return fallback.transcribe(audio, mimeType);
      }
    },
  };
}

/** The configured provider, or null when no transcription key is set. `geminiKey` replaces the server's Gemini key. */
export function transcriptionProvider(geminiKey = config.GEMINI_API_KEY): TranscriptionProvider | null {
  const extra = config.TRANSCRIBE_EXTRA_LANGUAGES.split(",").map((l) => l.trim()).filter(Boolean);
  const viaDeepgram = config.DEEPGRAM_API_KEY
    ? deepgram(config.DEEPGRAM_API_KEY, extra, banglaTranscriber(config.TRANSCRIBE_BANGLA_PROVIDER, geminiKey))
    : null;
  if (config.TRANSCRIPTION_PROVIDER === "gemini") {
    if (geminiKey) return voicesOnly(gemini(geminiKey, config.GEMINI_MODEL), viaDeepgram ?? undefined);
    console.error("[transcribe] TRANSCRIPTION_PROVIDER=gemini needs GEMINI_API_KEY; using Deepgram");
  }
  return viaDeepgram;
}

/** The transcriber for calls that aren't clearly English; undefined means Deepgram's own Bangla. */
export function banglaTranscriber(
  choice: "deepgram" | "whisper" | "gemini",
  geminiKey = config.GEMINI_API_KEY,
): LineTranscriber | undefined {
  if (choice === "whisper") {
    if (config.GROQ_API_KEY) return groqWhisper(config.GROQ_API_KEY, config.GROQ_WHISPER_MODEL);
    console.error("[transcribe] TRANSCRIBE_BANGLA_PROVIDER=whisper needs GROQ_API_KEY; using Deepgram");
  }
  if (choice === "gemini") {
    if (geminiKey) return gemini(geminiKey, config.GEMINI_MODEL);
    console.error("[transcribe] TRANSCRIBE_BANGLA_PROVIDER=gemini needs GEMINI_API_KEY; using Deepgram");
  }
  return undefined;
}

const FAILED_PREFIX = "Transcription failed";
/** Shown on the meeting when a requested re-transcription fails; the old transcript is kept. */
export const REGENERATE_FAILED_PREFIX = "Regenerating the transcript failed";
const attempts = new Map<string, number>();
const MAX_ATTEMPTS = 3;

/** Transcribes recorded sessions that don't have a transcript yet, or were asked to again, one at a time. */
export async function transcribePending(providerFor: (geminiKey?: string) => TranscriptionProvider) {
  // Sessions transcribed before this step marked them done (the summary step does that when it's on).
  if (!notesOn()) {
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
      meetingId: botSessions.meetingId,
      again: botSessions.retranscribeRequestedAt,
      geminiKey: users.geminiApiKey,
    })
    .from(botSessions)
    .innerJoin(meetings, eq(meetings.id, botSessions.meetingId))
    .innerJoin(users, eq(users.id, meetings.userId))
    .leftJoin(transcripts, eq(transcripts.botSessionId, botSessions.id))
    .where(
      or(
        and(
          eq(botSessions.status, "processing"),
          isNotNull(botSessions.recordingKey),
          isNull(transcripts.id),
          or(isNull(botSessions.error), not(like(botSessions.error, `${FAILED_PREFIX}%`))),
        ),
        and(isNotNull(botSessions.retranscribeRequestedAt), isNotNull(botSessions.recordingKey)),
      ),
    )
    .limit(5);

  for (const s of pending) {
    const log = (msg: string) => console.log(`[transcribe ${s.id}] ${msg}`);
    try {
      const provider = providerFor(ownGeminiKey(s.geminiKey));
      const audio = await readFile(path.join(config.STORAGE_DIR, s.key!));
      log(`Sending ${audio.length} bytes to ${provider.name}`);
      const result = await provider.transcribe(audio, "audio/webm");
      const { language } = result;
      const segments = nameTranscript(result.segments, s.timeline, s.participants);
      if (s.again) {
        await saveRegenerated(s.id, s.meetingId, language, segments);
        log(segments.length ? `Regenerated: ${segments.length} segments` : "Regenerated transcript was empty; kept the old one");
        attempts.delete(s.id);
        continue;
      }
      await db.insert(transcripts).values({ botSessionId: s.id, language, segments }).onConflictDoNothing();
      // With AI notes on, the summary step marks the session done; empty transcripts have nothing to summarize.
      if (!notesOn() || segments.length === 0) {
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
          .set(
            s.again
              ? { retranscribeRequestedAt: null, error: `${REGENERATE_FAILED_PREFIX}: ${String(err).slice(0, 300)}` }
              : { error: `${FAILED_PREFIX}: ${String(err).slice(0, 300)}` },
          )
          .where(eq(botSessions.id, s.id));
        attempts.delete(s.id);
      }
    }
  }
}

/**
 * Replaces a call's transcript with a fresh one and drops its notes, so the summary step writes them
 * again. An empty result keeps the old transcript.
 */
async function saveRegenerated(id: string, meetingId: string, language: string | null, segments: TranscriptSegment[]) {
  await db.transaction(async (tx) => {
    if (segments.length) {
      await tx
        .insert(transcripts)
        .values({ botSessionId: id, language, segments })
        .onConflictDoUpdate({ target: transcripts.botSessionId, set: { language, segments } });
      if (notesOn()) await tx.delete(notes).where(eq(notes.meetingId, meetingId));
    }
    await tx
      .update(botSessions)
      .set({
        retranscribeRequestedAt: null,
        error: null,
        status: segments.length && notesOn() ? "processing" : "completed",
      })
      .where(eq(botSessions.id, id));
  });
}
