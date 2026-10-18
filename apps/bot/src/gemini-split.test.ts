import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gemini } from "./gemini";

afterEach(() => vi.unstubAllGlobals());

describe("gemini", () => {
  it("retries a piece it couldn't finish as two halves", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mf-gem-"));
    const file = path.join(dir, "a.webm");
    execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "sine=f=440:d=400", "-c:a", "libopus", file]);
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      const text = calls === 1 ? '[{"start": 1, "end": 2, "speaker": "A", "te' : JSON.stringify([{ start: 1, end: 2, speaker: "A", text: `part ${calls}` }]);
      return new Response(JSON.stringify({ candidates: [{ finishReason: calls === 1 ? "MAX_TOKENS" : "STOP", content: { parts: [{ text }] } }] }));
    });
    const lines = await gemini("key").transcribe(readFileSync(file));
    // A 400-second call: the second half starts about 200 seconds in.
    expect(lines.map((l) => l.text)).toEqual(["part 2", "part 3"]);
    expect(lines[0]!.startMs).toBe(1_000);
    expect(lines[1]!.startMs).toBeGreaterThan(200_000);
    expect(lines[1]!.startMs).toBeLessThan(204_000);
  }, 60_000);
});
