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

describe("deepgramSegments word voices", () => {
  it("splits off a reply Deepgram heard in another voice at the start of a line", async () => {
    const { deepgramSegments } = await import("./transcribe");
    const w = (word: string, start: number, speaker: number) => ({ word, start, end: start + 0.3, speaker });
    const segments = deepgramSegments({
      results: {
        utterances: [
          {
            start: 90.9,
            end: 94.2,
            transcript: "হ্যাঁ, সমস্যা নাই। তোমার হচ্ছে এই তিনটা।",
            speaker: 0,
            words: [w("হ্যাঁ,", 90.9, 1), w("সমস্যা", 91.4, 1), w("নাই।", 91.8, 1), w("তোমার", 92.4, 0), w("হচ্ছে", 92.8, 0), w("এই", 93.2, 0), w("তিনটা।", 93.6, 0)],
          },
        ],
      },
    });
    expect(segments.map((s) => [s.speaker, s.text])).toEqual([
      ["Speaker 2", "হ্যাঁ, সমস্যা নাই।"],
      ["Speaker 1", "তোমার হচ্ছে এই তিনটা।"],
    ]);
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

  it("splits a line where the captions change speaker", async () => {
    const { nameSpeakers } = await import("./transcribe");
    // Like the call with Amir: a quick exchange heard as one voice and run into one line.
    const words = "Hi Amir how are you Doing great thanks how about you".split(" ").map((text, i) => ({
      text,
      startMs: 60_000 + i * 500,
      endMs: 60_000 + i * 500 + 400,
    }));
    const named = nameSpeakers(
      [{ speaker: "Speaker 1", startMs: 60_000, endMs: 65_400, text: words.map((w) => w.text).join(" "), words }],
      [
        { name: "Mohammed Shariful Islam", startMs: 59_800, endMs: 62_400 },
        { name: "Amir Khosrodad", startMs: 62_400, endMs: 66_000 },
      ],
    );
    expect(named).toEqual([
      { speaker: "Mohammed Shariful Islam", startMs: 60_000, endMs: 62_400, text: "Hi Amir how are you" },
      { speaker: "Amir Khosrodad", startMs: 62_500, endMs: 65_400, text: "Doing great thanks how about you" },
    ]);
  });

  it("ignores a speaker change of a word or two", async () => {
    const { splitByCaptions } = await import("./transcribe");
    const words = [0, 1, 2, 3, 4, 5].map((i) => ({ text: `w${i}`, startMs: i * 500, endMs: i * 500 + 400 }));
    const pieces = splitByCaptions(words, [
      { name: "A", startMs: 0, endMs: 3_000 },
      { name: "B", startMs: 1_000, endMs: 1_500 },
    ]);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.name).toBe("A");
  });

  it("moves a speaker change to the pause where the next person began", async () => {
    const { splitByCaptions } = await import("./transcribe");
    // Captions put the change a word late; the real change is the pause after "you".
    const at = [0, 400, 800, 1_200, 1_600, 2_600, 3_000, 3_400, 3_800];
    const words = "Hi Amir how are you Hello my friend yes".split(" ").map((text, i) => ({ text, startMs: at[i]!, endMs: at[i]! + 300 }));
    const pieces = splitByCaptions(words, [
      { name: "Sharif", startMs: 0, endMs: 2_500 },
      { name: "Amir", startMs: 1_400, endMs: 4_500 },
    ]);
    expect(pieces.map((p) => [p.name, p.words.map((w) => w.text).join(" ")])).toEqual([
      ["Sharif", "Hi Amir how are you"],
      ["Amir", "Hello my friend yes"],
    ]);
  });

  it("gives speech in a caption gap to the person whose caption comes next", async () => {
    const { splitByCaptions } = await import("./transcribe");
    // Like the call with Shihab: no captions for ten seconds while Sharif spoke, then his caption appeared late.
    const at = [0, 400, 800, 1_200, 1_600, 2_000, 2_400, 4_000, 4_400, 4_800, 5_200, 5_600, 6_000];
    const words = at.map((ms, i) => ({ text: `w${i}`, startMs: 160_000 + ms, endMs: 160_000 + ms + 300 }));
    const pieces = splitByCaptions(words, [
      { name: "Shihab", startMs: 150_000, endMs: 161_000 },
      { name: "Sharif", startMs: 170_000, endMs: 172_000 },
    ]);
    expect(pieces.map((p) => [p.name, p.words.length])).toEqual([
      ["Shihab", 7],
      ["Sharif", 6],
    ]);
  });

  it("splits a Bangla line that has no word times where the captions change speaker", async () => {
    const { nameSpeakers } = await import("./transcribe");
    // Like the call with Shihab: Whisper wrote one long line across both speakers.
    const text = "আমার কাছে মনে হচ্ছে ভাই ভ্যালিড খুবই ভ্যালিড পয়েন্ট আমার মনে হয় তাহলে আমরা ভাইয়ের সাথে আরেকবার একটু ডিসকাস করি";
    const named = nameSpeakers(
      [{ speaker: "Speaker 1", startMs: 160_000, endMs: 172_000, text }],
      [
        { name: "Shihab Bhuiyan", startMs: 150_000, endMs: 166_000 },
        { name: "Mohammed Shariful Islam", startMs: 165_500, endMs: 180_000 },
      ],
    );
    expect(named.map((s) => s.speaker)).toEqual(["Shihab Bhuiyan", "Mohammed Shariful Islam"]);
    expect(named.map((s) => s.text).join(" ")).toBe(text);
    expect(named[1]!.startMs).toBeGreaterThan(165_000);
  });

  it("gives a short reply in another voice to its speaker inside someone's long caption block", async () => {
    const { nameSpeakers } = await import("./transcribe");
    // Like the MyPeople scrum: one 60-second caption block for Sharif, with Jehan's "ok" inside it.
    const named = nameSpeakers(
      [
        { speaker: "Speaker 2", startMs: 10_000, endMs: 20_000, text: "a b c d" },
        { speaker: "Speaker 1", startMs: 30_000, endMs: 60_000, text: "e f g h" },
        { speaker: "Speaker 2", startMs: 61_000, endMs: 62_000, text: "ok" },
        { speaker: "Speaker 1", startMs: 62_500, endMs: 90_000, text: "i j k l" },
      ],
      [
        { name: "Jehan", startMs: 9_000, endMs: 21_000 },
        { name: "Sharif", startMs: 29_000, endMs: 91_000 },
      ],
    );
    expect(named.map((s) => s.speaker)).toEqual(["Jehan", "Sharif", "Jehan", "Sharif"]);
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
