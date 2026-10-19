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

  it("names lines from the captions when diarization heard two people as one voice", async () => {
    const { nameSpeakers } = await import("./transcribe");
    // Like the Akij Bakers call: one label for everyone, and Sharif's caption turn left open around Shihab's.
    const named = nameSpeakers(
      [seg("Speaker 1", 9_000, 18_000), seg("Speaker 1", 19_000, 33_000), seg("Speaker 1", 35_000, 60_000)],
      [
        { name: "Mohammed Shariful Islam", startMs: 8_800, endMs: 69_800 },
        { name: "Shihab Bhuiyan", startMs: 21_800, endMs: 33_800 },
      ],
    );
    expect(named.map((s) => s.speaker)).toEqual(["Mohammed Shariful Islam", "Shihab Bhuiyan", "Mohammed Shariful Islam"]);
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

describe("voicesOnly", () => {
  it("numbers Gemini's voices and falls back when Gemini fails", async () => {
    const { voicesOnly } = await import("./transcribe");
    const lines = {
      name: "Gemini",
      transcribe: async () => [
        { startMs: 0, endMs: 1_000, text: "আমরা শুরু করি", voice: "0:A" },
        { startMs: 1_000, endMs: 2_000, text: "Sure, go ahead", voice: "0:B" },
        { startMs: 2_000, endMs: 3_000, text: "ঠিক আছে", voice: "0:A" },
      ],
    };
    expect(await voicesOnly(lines).transcribe(Buffer.from("a"), "audio/webm")).toEqual({
      language: "bn,en",
      segments: [
        { speaker: "Speaker 1", startMs: 0, endMs: 1_000, text: "আমরা শুরু করি" },
        { speaker: "Speaker 2", startMs: 1_000, endMs: 2_000, text: "Sure, go ahead" },
        { speaker: "Speaker 1", startMs: 2_000, endMs: 3_000, text: "ঠিক আছে" },
      ],
    });

    const broken = { name: "Gemini", transcribe: async () => Promise.reject(new Error("Gemini returned 429")) };
    const fallback = { name: "Deepgram", transcribe: async () => ({ language: "en", segments: [] }) };
    expect(await voicesOnly(broken, fallback).transcribe(Buffer.from("a"), "audio/webm")).toEqual({ language: "en", segments: [] });
    await expect(voicesOnly(broken).transcribe(Buffer.from("a"), "audio/webm")).rejects.toThrow("429");
  });
});
