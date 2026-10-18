import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { WhisperSegment } from "./whisper";

const run = promisify(execFile);

// Five minutes of a busy call stays well inside both the inline request size and the reply length.
const CHUNK_S = 300;

const PROMPT = `Transcribe this meeting recording verbatim.
- Write Bangla in Bengali script and English words in Latin script, exactly as spoken. Do not translate, correct or summarise.
- Leave out silence, music and background noise. Never invent words that weren't said.
- Names and terms that may come up: MinuteFlow, Minute Flow, Google Meet.
- Split the transcript into short segments at natural pauses or speaker changes.
- "start" and "end" are seconds from the start of this recording.`;

const SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: { start: { type: "NUMBER" }, end: { type: "NUMBER" }, text: { type: "STRING" } },
    required: ["start", "end", "text"],
  },
};

type GeminiResponse = { candidates?: { content?: { parts?: { text?: string }[] } }[] };

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
      const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      return geminiSegments(text, offsetMs);
    }
  }

  return {
    name: `Gemini (${model})`,
    async transcribe(audio: Buffer): Promise<WhisperSegment[]> {
      const chunks = await oggChunks(audio, CHUNK_S);
      const lines: WhisperSegment[] = [];
      for (const [i, chunk] of chunks.entries()) lines.push(...(await transcribeChunk(chunk, i * CHUNK_S * 1000)));
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
    const { start, end, text } = (s ?? {}) as { start?: unknown; end?: unknown; text?: unknown };
    if (typeof start !== "number" || typeof text !== "string" || !text.trim()) return [];
    const startMs = Math.round(start * 1000) + offsetMs;
    const endMs = typeof end === "number" && end >= start ? Math.round(end * 1000) + offsetMs : startMs + 1000;
    return [{ startMs, endMs, text: text.trim() }];
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
