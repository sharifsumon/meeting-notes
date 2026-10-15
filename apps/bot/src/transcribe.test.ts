import { describe, expect, it } from "vitest";

Object.assign(process.env, {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://unused",
  REDIS_URL: process.env.REDIS_URL ?? "redis://unused",
  STORAGE_DIR: process.env.STORAGE_DIR ?? "/tmp",
  CHROME_PATH: process.env.CHROME_PATH ?? "/unused",
});

describe("deepgramSegments", () => {
  it("maps utterances to numbered speakers in milliseconds and drops empty ones", async () => {
    const { deepgramSegments } = await import("./transcribe");
    expect(
      deepgramSegments({
        results: {
          utterances: [
            { start: 0.5, end: 2.25, transcript: " Hello everyone. ", speaker: 0 },
            { start: 2.5, end: 3, transcript: "  ", speaker: 1 },
            { start: 3.1, end: 5, transcript: "Hi!", speaker: 1 },
          ],
        },
      }),
    ).toEqual([
      { speaker: "Speaker 1", startMs: 500, endMs: 2250, text: "Hello everyone." },
      { speaker: "Speaker 2", startMs: 3100, endMs: 5000, text: "Hi!" },
    ]);
    expect(deepgramSegments({})).toEqual([]);
  });
});

describe("deepgram language fallback", () => {
  const response = (language: string, languageConfidence: number, confidence: number) => ({
    results: {
      channels: [{ detected_language: language, language_confidence: languageConfidence, alternatives: [{ confidence }] }],
      utterances: [{ start: 0, end: 1, transcript: "text", speaker: 0 }],
    },
  });

  async function run(responses: object[]) {
    const { deepgram } = await import("./transcribe");
    const urls: URL[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: URL) => {
      urls.push(url);
      return new Response(JSON.stringify(responses[urls.length - 1]));
    }) as typeof fetch;
    try {
      const result = await deepgram("key", ["bn"]).transcribe(Buffer.from("a"), "audio/webm");
      return { result, urls };
    } finally {
      globalThis.fetch = real;
    }
  }

  it("trusts confident English and makes one request", async () => {
    const { result, urls } = await run([response("en", 0.97, 0.95)]);
    expect(urls).toHaveLength(1);
    expect(result.language).toBe("en");
  });

  it("re-runs with Bangla when detection guesses another language, and keeps the better transcript", async () => {
    const { result, urls } = await run([response("hi", 0.6, 0.41), response("", 0, 0.88)]);
    expect(urls).toHaveLength(2);
    expect(urls[0]!.searchParams.get("detect_language")).toBe("true");
    expect(urls[1]!.searchParams.get("language")).toBe("bn");
    expect(urls[1]!.searchParams.has("detect_language")).toBe(false);
    expect(result.language).toBe("bn");
  });

  it("keeps the detected language when the Bangla transcript is worse", async () => {
    const { result } = await run([response("en", 0.7, 0.9), response("", 0, 0.3)]);
    expect(result.language).toBe("en");
  });
});
