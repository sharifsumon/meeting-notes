import { afterEach, describe, expect, it, vi } from "vitest";

Object.assign(process.env, {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://unused",
  REDIS_URL: process.env.REDIS_URL ?? "redis://unused",
  STORAGE_DIR: process.env.STORAGE_DIR ?? "/tmp",
  CHROME_PATH: process.env.CHROME_PATH ?? "/unused",
});

const seg = (startMs: number, speaker: string, text: string) => ({ speaker, startMs, endMs: startMs + 1000, text });

afterEach(() => vi.unstubAllGlobals());

describe("summaries", () => {
  it("splits transcripts into chunks with timestamps and speakers", async () => {
    const { transcriptChunks } = await import("./summarize");
    const chunks = transcriptChunks([seg(0, "Speaker 1", "Hello"), seg(65_000, "Speaker 2", "Hi there")], 30);
    expect(chunks).toEqual(["[0:00] Speaker 1: Hello\n", "[1:05] Speaker 2: Hi there\n"]);
  });

  it("parses model JSON leniently", async () => {
    const { parseNotes } = await import("./summarize");
    expect(
      parseNotes(
        JSON.stringify({
          summary: " We agreed. ",
          decisions: ["Ship Friday", 3, ""],
          actionItems: [{ text: "Write docs", owner: "Rafi", due: "Fri" }, { text: "Test" }, { nope: 1 }],
        }),
      ),
    ).toEqual({
      summary: "We agreed.",
      keyPoints: [],
      decisions: ["Ship Friday"],
      actionItems: [{ text: "Write docs", owner: "Rafi", dueDate: "Fri" }, { text: "Test" }],
    });
  });

  it("retries Groq rate limits, then returns notes", async () => {
    const { groq } = await import("./summarize");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "0.01" } }))
      .mockResolvedValueOnce(
        Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "Done.", decisions: ["A"] }) } }] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const notes = await groq("key", "openai/gpt-oss-120b").summarize({ title: "Sync", segments: [seg(0, "Speaker 1", "Hi")] });
    expect(notes).toEqual({ summary: "Done.", keyPoints: [], decisions: ["A"], actionItems: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
    expect(body.model).toBe("openai/gpt-oss-120b");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[1].content).toContain("[0:00] Speaker 1: Hi");
  });
});
