import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { WhisperSegment } from "./whisper";

const run = promisify(execFile);

// Fifteen minutes keeps most calls in one piece, so Gemini's voice letters cover the whole call,
// and stays inside the inline request size and the reply length.
const CHUNK_S = 900;

const PROMPT = `Transcribe this meeting recording verbatim.
- Write Bangla in Bengali script and English words in Latin script, exactly as spoken. Do not translate, correct or summarise.
- Leave out silence, music and background noise. Never invent words that weren't said.
- Names and terms that may come up: MinuteFlow, Minute Flow, Google Meet.
- Split the transcript into short segments at natural pauses and at every change of speaker.
- "speaker" tells voices apart: "A" for the first voice heard, "B" for the second, and so on. The same voice keeps its letter for the whole recording, and a new voice gets the next letter.
- "start" and "end" are seconds from the start of this recording.`;

const SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: { start: { type: "NUMBER" }, end: { type: "NUMBER" }, speaker: { type: "STRING" }, text: { type: "STRING" } },
    required: ["start", "end", "speaker", "text"],
  },
};

type GeminiResponse = { candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[] };

// Pieces shorter than this aren't split again when Gemini can't finish them.
const MIN_SPLIT_S = 120;

/** Gemini transcribes Bangla and calls that switch between Bangla and English. */
export function gemini(apiKey: string, model = "gemini-3.8-flash") {
  async function transcribeChunk(ogg: Buffer, offsetMs: number): Promise<WhisperSegment[]> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: "audio/ogg", data: ogg.toString("base64") } }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: SCHEMA,
            thinkingConfig: { thinkingBudget: 0 },
            maxOutputTokens: 65_536,
          },
        }),
        signal: AbortSignal.timeout(10 * 60_000),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 5_000, 120_000)));
        continue;
      }
      if (!res.ok) throw new Error(`Gemini returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as GeminiResponse;
      const candidate = body.candidates?.[0];
      const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      try {
        return geminiSegments(text, offsetMs);
      } catch {
        throw new Error(`Gemini's reply couldn't be read (finish reason ${candidate?.finishReason ?? "none"}, ${text.length} characters)`);
      }
    }
  }

  /** Transcribes a piece; one Gemini can't finish (a busy stretch, an empty reply) is retried as two halves. */
  async function transcribePiece(ogg: Buffer, offsetMs: number, seconds: number): Promise<WhisperSegment[]> {
    try {
      return await transcribeChunk(ogg, offsetMs);
    } catch (err) {
      // The last piece of a call is usually shorter than CHUNK_S.
      const length = Math.min(seconds, await durationS(ogg));
      if (length / 2 < MIN_SPLIT_S || !String(err).includes("couldn't be read")) throw err;
      console.log(`[gemini] ${err}; retrying ${Math.round(length)}s from ${offsetMs / 1000}s as two halves`);
      const half = Math.ceil(length / 2);
      const lines: WhisperSegment[] = [];
      for (const [i, part] of (await oggChunks(ogg, half)).entries()) {
        lines.push(...(await transcribePiece(part, offsetMs + i * half * 1000, half)));
      }
      return lines;
    }
  }

  return {
    name: `Gemini (${model})`,
    async transcribe(audio: Buffer): Promise<WhisperSegment[]> {
      const chunks = await oggChunks(audio, CHUNK_S);
      const lines: WhisperSegment[] = [];
      for (const [i, chunk] of chunks.entries()) lines.push(...(await transcribePiece(chunk, i * CHUNK_S * 1000, CHUNK_S)));
      // Gemini's timestamps sometimes step backwards.
      return lines.sort((a, b) => a.startMs - b.startMs);
    },
  };
}

/** Parses Gemini's JSON segments, shifting them by the chunk's start. */
export function geminiSegments(json: string, offsetMs: number): WhisperSegment[] {
  const raw = parseCutOff(json);
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((s): WhisperSegment[] => {
    const { start, end, text, speaker } = (s ?? {}) as { start?: unknown; end?: unknown; text?: unknown; speaker?: unknown };
    if (typeof start !== "number" || typeof text !== "string" || !text.trim()) return [];
    const startMs = Math.round(start * 1000) + offsetMs;
    const endMs = typeof end === "number" && end >= start ? Math.round(end * 1000) + offsetMs : startMs + 1000;
    // Gemini's letters only hold within one piece of the recording, so the piece's start is part of the label.
    const voice = typeof speaker === "string" && speaker.trim() ? `${offsetMs}:${speaker.trim().toUpperCase()}` : undefined;
    return [{ startMs, endMs, text: text.trim(), ...(voice ? { voice } : {}) }];
  });
}

/** Parses a JSON array, keeping the complete items when the reply was cut off mid-array. */
function parseCutOff(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (err) {
    const lastItem = json.lastIndexOf("}");
    if (!json.trimStart().startsWith("[") || lastItem < 0) throw err;
    return JSON.parse(`${json.slice(0, lastItem + 1)}]`);
  }
}

/** How long an Ogg piece plays, in seconds. */
async function durationS(ogg: Buffer): Promise<number> {
  const dir = await mkdtemp(path.join(tmpdir(), "mf-len-"));
  try {
    const file = path.join(dir, "piece.ogg");
    await writeFile(file, ogg);
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    return Number(stdout.trim()) || 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Rewraps the recording's Opus audio as Ogg (Gemini doesn't take WebM), in pieces of `seconds`. */
async function oggChunks(audio: Buffer, seconds: number): Promise<Buffer[]> {
  const dir = await mkdtemp(path.join(tmpdir(), "mf-ogg-"));
  try {
    const input = path.join(dir, "in.webm");
    await writeFile(input, audio);
    const args = ["-loglevel", "error", "-i", input, "-vn", "-c:a", "copy", "-f", "segment", "-segment_time", String(seconds)];
    await run("ffmpeg", [...args, path.join(dir, "part-%03d.ogg")]);
    const parts = (await readdir(dir)).filter((f) => f.startsWith("part-")).sort();
    return Promise.all(parts.map((f) => readFile(path.join(dir, f))));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
