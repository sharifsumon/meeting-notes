import { describe, expect, it } from "vitest";
import { geminiSegments } from "./gemini";

describe("geminiSegments", () => {
  it("reads Gemini's JSON segments, shifted by the chunk's start", () => {
    const json = JSON.stringify([
      { start: 1.5, end: 4, text: " আমরা আজকে deploy করব। " },
      { start: 5, text: "Okay" },
      { start: 6, end: 7, text: "" },
      { text: "no time" },
    ]);
    expect(geminiSegments(json, 600_000)).toEqual([
      { startMs: 601_500, endMs: 604_000, text: "আমরা আজকে deploy করব।" },
      { startMs: 605_000, endMs: 606_000, text: "Okay" },
    ]);
    expect(geminiSegments("{}", 0)).toEqual([]);
  });

  it("keeps the complete segments of a reply that was cut off", () => {
    const json = '[{"start": 1, "end": 2, "text": "এক"}, {"start": 3, "end": 4, "text": "দুই"}, {"start": 5, "end"';
    expect(geminiSegments(json, 0).map((s) => s.text)).toEqual(["এক", "দুই"]);
  });
});
