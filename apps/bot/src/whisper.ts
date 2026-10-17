import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { TranscriptSegment } from "@minuteflow/db";

const run = promisify(execFile);

/** A stretch of speech Whisper heard, without a speaker. */
export type WhisperSegment = { startMs: number; endMs: number; text: string };

// Groq takes files up to 25 MB; longer calls are sent in pieces of this many seconds.
const MAX_BYTES = 24 * 1024 * 1024;
const CHUNK_S = 300;

// Showing Whisper a mixed sentence keeps it writing each language as spoken instead of translating.
// Kept to words, not a sentence: Whisper repeats a sentence-like prompt as if someone said it.
const MIXED_PROMPT = "Bangla, English, meeting, deadline, deploy, বাংলা, মিটিং";

/** Groq's Whisper, which handles Bangla and calls that switch between Bangla and English. */
export function groqWhisper(apiKey: string, model = "whisper-large-v3") {
  async function transcribeFile(audio: Buffer, filename: string, offsetMs: number, language?: string): Promise<WhisperSegment[]> {
    for (let attempt = 0; ; attempt++) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/webm" }), filename);
      form.append("model", model);
      form.append("response_format", "verbose_json");
      form.append("temperature", "0");
      form.append("prompt", MIXED_PROMPT);
      // Left to guess, Whisper drifts into other Indian scripts on short Bangla clips.
      if (language) form.append("language", language);
      const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(10 * 60_000),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 5_000;
        await new Promise((r) => setTimeout(r, Math.min(waitMs, 120_000)));
        continue;
      }
      if (!res.ok) throw new Error(`Groq Whisper returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as { segments?: RawSegment[] };
      return whisperSegments(body.segments ?? [], offsetMs);
    }
  }

  return {
    name: `Groq Whisper (${model})`,
    /** `language` ("bn") pins the main language; English words still come out in English. */
    async transcribe(audio: Buffer, language?: string): Promise<WhisperSegment[]> {
      if (audio.length <= MAX_BYTES) return transcribeFile(audio, "call.webm", 0, language);
      const chunks = await splitAudio(audio, CHUNK_S);
      const segments: WhisperSegment[] = [];
      for (const [i, chunk] of chunks.entries())
        segments.push(...(await transcribeFile(chunk, `call-${i}.webm`, i * CHUNK_S * 1000, language)));
      return segments;
    },
  };
}

type RawSegment = {
  start: number;
  end: number;
  text: string;
  no_speech_prob?: number;
  avg_logprob?: number;
  compression_ratio?: number;
};

// Whisper fills silence with stock phrases; drop the common ones.
const HALLUCINATION =
  /^(thank you( (so|very) much)?( for watching)?[.!]*|thanks for watching[.!]*|you|\.+|subtitles by .*|please subscribe.*)$/i;
// Letters from scripts other than Bangla and Latin mean Whisper lost track of the language.
const OTHER_SCRIPT = /[\u0900-\u097F\u0A00-\u0D7F\u0E00-\u0FFF]/gu;

/**
 * Keeps the lines Whisper actually heard. Its own thresholds mark the rest: likely silence
 * (no_speech_prob with a low avg_logprob), or looping text (high compression_ratio).
 */
export function whisperSegments(raw: RawSegment[], offsetMs: number): WhisperSegment[] {
  return raw
    .filter((s) => !((s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -1))
    .filter((s) => (s.compression_ratio ?? 0) <= 2.4)
    .map((s) => ({
      startMs: Math.round(s.start * 1000) + offsetMs,
      endMs: Math.round(s.end * 1000) + offsetMs,
      text: s.text.trim(),
    }))
    .filter((s) => {
      const letters = s.text.replace(/[^\p{L}]/gu, "").length;
      const stray = s.text.match(OTHER_SCRIPT)?.length ?? 0;
      return s.text && !HALLUCINATION.test(s.text) && stray <= letters * 0.1;
    });
}

/** Splits a recording into pieces of `seconds` with ffmpeg, without re-encoding. */
async function splitAudio(audio: Buffer, seconds: number): Promise<Buffer[]> {
  const dir = await mkdtemp(path.join(tmpdir(), "mf-split-"));
  try {
    const input = path.join(dir, "in.webm");
    await writeFile(input, audio);
    await run("ffmpeg", [
      "-loglevel",
      "error",
      "-i",
      input,
      "-f",
      "segment",
      "-segment_time",
      String(seconds),
      "-c",
      "copy",
      path.join(dir, "part-%03d.webm"),
    ]);
    const parts = (await readdir(dir)).filter((f) => f.startsWith("part-")).sort();
    return Promise.all(parts.map((f) => readFile(path.join(dir, f))));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Gives each of Whisper's lines the speaker Deepgram heard at the same time. Whisper writes Bangla
 * and mixed speech well but can't tell voices apart; Deepgram's diarization can.
 */
export function assignSpeakers(lines: WhisperSegment[], diarized: TranscriptSegment[]): TranscriptSegment[] {
  let last = diarized[0]?.speaker ?? "Speaker 1";
  return lines.map((line) => {
    const overlap = new Map<string, number>();
    for (const d of diarized) {
      const ms = Math.min(line.endMs, d.endMs) - Math.max(line.startMs, d.startMs);
      if (ms > 0) overlap.set(d.speaker, (overlap.get(d.speaker) ?? 0) + ms);
    }
    // Lines in a pause Deepgram didn't diarize keep the previous speaker.
    const best = [...overlap].sort((a, b) => b[1] - a[1])[0];
    if (best) last = best[0];
    return { speaker: last, startMs: line.startMs, endMs: line.endMs, text: line.text };
  });
}

const BENGALI = /[ঀ-৿]/;
const LATIN = /[A-Za-z]/;

/** "bn", "en" or "bn,en", from the scripts the lines are written in. */
export function scriptLanguage(segments: TranscriptSegment[]): string | null {
  const total = segments.length || 1;
  const bn = segments.filter((s) => BENGALI.test(s.text)).length / total;
  const en = segments.filter((s) => LATIN.test(s.text)).length / total;
  const spoken = [...(bn >= 0.1 ? ["bn"] : []), ...(en >= 0.1 ? ["en"] : [])];
  return spoken.length ? spoken.join(",") : null;
}
