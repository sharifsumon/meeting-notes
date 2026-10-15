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
