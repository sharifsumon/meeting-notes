import { describe, expect, it } from "vitest";
import { assignSpeakers, scriptLanguage, whisperSegments } from "./whisper";

describe("whisper", () => {
  it("offsets chunk timestamps and drops silence fillers", () => {
    expect(
      whisperSegments(
        [
          { start: 0, end: 2.5, text: " আমরা আজকে শুরু করি " },
          { start: 3, end: 4, text: " Thank you." },
        ],
        300_000,
      ),
    ).toEqual([{ startMs: 300_000, endMs: 302_500, text: "আমরা আজকে শুরু করি" }]);
  });

  it("drops what Whisper marks as silence or garbled", () => {
    const seg = (text: string, extra = {}) => ({ start: 0, end: 1, text, ...extra });
    expect(
      whisperSegments(
        [
          seg("Thank you for watching!"),
          seg("হ্যালো", { no_speech_prob: 0.9, avg_logprob: -1.4 }),
          seg("ok ok ok ok", { compression_ratio: 3.1 }),
          seg("এটি ബിഷ്ണു വിഷയം"),
          seg("আমরা শুরু করি"),
        ],
        0,
      ).map((s) => s.text),
    ).toEqual(["আমরা শুরু করি"]);
  });

  it("gives Whisper's lines the speaker Deepgram heard at that time", () => {
    const diarized = [
      { speaker: "Sharif", startMs: 0, endMs: 4_000, text: "x" },
      { speaker: "Rayyan", startMs: 4_200, endMs: 9_000, text: "y" },
    ];
    const lines = [
      { startMs: 0, endMs: 3_800, text: "আমরা deploy করব।" },
      { startMs: 4_300, endMs: 8_000, text: "Okay, আমি দেখছি।" },
      { startMs: 9_500, endMs: 10_000, text: "ঠিক আছে।" },
    ];
    expect(assignSpeakers(lines, diarized).map((s) => s.speaker)).toEqual(["Sharif", "Rayyan", "Rayyan"]);
  });

  it("reads the languages from the script the lines are written in", () => {
    const line = (text: string) => ({ speaker: "S", startMs: 0, endMs: 1, text });
    expect(scriptLanguage([line("আমরা deploy করব"), line("Let's go")])).toBe("bn,en");
    expect(scriptLanguage([line("আমরা করব"), line("ঠিক আছে")])).toBe("bn");
    expect(scriptLanguage([line("Hello")])).toBe("en");
  });
});
