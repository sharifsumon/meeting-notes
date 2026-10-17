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
    const { result, urls } = await run([response("hi", 0.6, 0.41), response("", 0, 0.88), response("", 0, 0.5)]);
    expect(urls).toHaveLength(3);
    expect(urls[0]!.searchParams.get("detect_language")).toBe("true");
    expect(urls[1]!.searchParams.get("language")).toBe("bn");
    expect(urls[1]!.searchParams.has("detect_language")).toBe(false);
    expect(urls[2]!.searchParams.get("language")).toBe("en");
    expect(result.language).toBe("bn");
  });

  it("keeps the detected language when the Bangla transcript is worse", async () => {
    const { result } = await run([response("en", 0.7, 0.9), response("", 0, 0.3)]);
    expect(result.language).toBe("en");
  });
});

describe("deepgram with Whisper", () => {
  it("uses Whisper's words with Deepgram's speakers when the call isn't clearly English", async () => {
    const { deepgram } = await import("./transcribe");
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: {
            channels: [{ detected_language: "en", language_confidence: 0.5, alternatives: [{ confidence: 0.6 }] }],
            utterances: [{ start: 0, end: 3, transcript: "Check for the.", speaker: 1 }],
          },
        }),
      )) as typeof fetch;
    const whisper = { name: "Whisper", transcribe: async () => [{ startMs: 0, endMs: 2_900, text: "আমরা deploy check করব।" }] };
    try {
      const result = await deepgram("key", ["bn"], whisper).transcribe(Buffer.from("a"), "audio/webm");
      expect(result).toEqual({
        language: "bn,en",
        segments: [{ speaker: "Speaker 2", startMs: 0, endMs: 2_900, text: "আমরা deploy check করব।" }],
      });
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("mergeAttempts", () => {
  const line = (speaker: string, startMs: number, endMs: number, text: string) => ({ speaker, startMs, endMs, text });
  const attempt = (language: string, confidence: number, lines: [ReturnType<typeof line>, number][]) => ({
    language,
    languageConfidence: 0,
    confidence,
    segments: lines.map(([l]) => l),
    segmentConfidence: lines.map(([, c]) => c),
  });

  it("takes each stretch of a mixed call from the language that heard it best", async () => {
    const { mergeAttempts } = await import("./transcribe");
    const bangla = attempt("bn", 0.8, [
      [line("Speaker 1", 0, 3_000, "আমরা আজকে শুরু করি"), 0.9],
      [line("Speaker 2", 3_500, 6_000, "ডেপ্লয় দ্য সার্ভার"), 0.4],
      [line("Speaker 1", 6_500, 9_000, "ঠিক আছে"), 0.85],
    ]);
    const english = attempt("en", 0.5, [
      [line("Speaker 1", 0, 3_000, "Um, I'm a shoe"), 0.3],
      [line("Speaker 1", 3_600, 4_800, "Let's deploy"), 0.92],
      [line("Speaker 1", 4_900, 5_900, "the server."), 0.9],
      [line("Speaker 2", 6_500, 9_000, "Take a chair."), 0.5],
    ]);
    const merged = mergeAttempts([bangla, english]);
    expect(merged.segments.map((s) => s.text)).toEqual(["আমরা আজকে শুরু করি", "Let's deploy the server.", "ঠিক আছে"]);
    // Speakers and timing come from the best attempt.
    expect(merged.segments[1]).toMatchObject({ speaker: "Speaker 2", startMs: 3_500, endMs: 6_000 });
    expect(merged.language).toBe("bn,en");
  });

  it("keeps a single language when the other never does clearly better", async () => {
    const { mergeAttempts } = await import("./transcribe");
    const merged = mergeAttempts([
      attempt("en", 0.9, [[line("Speaker 1", 0, 1_000, "Hello"), 0.9]]),
      attempt("bn", 0.3, [[line("Speaker 1", 0, 1_000, "হ্যালো"), 0.95]]),
    ]);
    expect(merged).toEqual({ language: "en", segments: [line("Speaker 1", 0, 1_000, "Hello")] });
  });
});

describe("nameSpeakers", () => {
  const seg = (speaker: string, startMs: number, endMs: number) => ({ speaker, startMs, endMs, text: "x" });

  it("gives each numbered speaker the name captions showed at the same time", async () => {
    const { nameSpeakers } = await import("./transcribe");
    const named = nameSpeakers(
      [seg("Speaker 1", 0, 4_000), seg("Speaker 2", 4_500, 8_000), seg("Speaker 1", 9_000, 10_000), seg("Speaker 3", 20_000, 21_000)],
      [
        { name: "Sharif Islam", startMs: 200, endMs: 4_200 },
        { name: "Guest Two", startMs: 4_400, endMs: 8_300 },
        { name: "Sharif Islam", startMs: 8_800, endMs: 10_000 },
      ],
    );
    expect(named.map((s) => s.speaker)).toEqual(["Sharif Islam", "Guest Two", "Sharif Islam", "Speaker 3"]);
  });

  it("leaves labels alone without captions", async () => {
    const { nameSpeakers } = await import("./transcribe");
    expect(nameSpeakers([seg("Speaker 1", 0, 1_000)], [])[0]!.speaker).toBe("Speaker 1");
  });
});

describe("nameOnlySpeaker", () => {
  const seg = (speaker: string) => ({ speaker, startMs: 0, endMs: 1, text: "x" });
  it("names the one voice after the one person Meet listed", async () => {
    const { nameOnlySpeaker } = await import("./transcribe");
    expect(nameOnlySpeaker([seg("Speaker 1"), seg("Speaker 1")], ["Sharif"]).map((s) => s.speaker)).toEqual(["Sharif", "Sharif"]);
    expect(nameOnlySpeaker([seg("Speaker 1"), seg("Speaker 2")], ["Sharif"])[1]!.speaker).toBe("Speaker 2");
    expect(nameOnlySpeaker([seg("Speaker 1")], ["Sharif", "Rayyan"])[0]!.speaker).toBe("Speaker 1");
  });
});
