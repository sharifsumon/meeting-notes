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
    expect(notes).toEqual({
      summary: "Done.",
      keyPoints: [],
      decisions: ["A"],
      actionItems: [],
      // No participant list or model attendees: the speaker labels stand in.
      minutes: { attendees: ["Speaker 1"], topics: [] },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
    expect(body.model).toBe("openai/gpt-oss-120b");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[1].content).toContain("[0:00] Speaker 1: Hi");
  });

  it("writes English notes for a Bangla call and translates them into Bangla", async () => {
    const { groq } = await import("./summarize");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "Deploy on Monday." }) } }] }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "সোমবার ডেপ্লয়।" }) } }] }));
    vi.stubGlobal("fetch", fetchMock);

    const model = groq("key", "openai/gpt-oss-120b");
    const english = await model.summarize({ title: "Sync", segments: [seg(0, "Speaker 1", "সোমবার deploy")], language: "English" });
    const bangla = await model.translate(english, "Bangla");
    expect(english.summary).toBe("Deploy on Monday.");
    expect(bangla.summary).toBe("সোমবার ডেপ্লয়।");
    const system = (call: number) => JSON.parse(fetchMock.mock.calls[call]![1].body as string).messages[0].content as string;
    expect(system(0)).toContain("Write the notes in English");
    expect(system(1)).toContain("translate meeting notes into Bangla");
  });
});

describe("minutes", () => {
  it("parses numbered topics with bullets nested at most three levels", async () => {
    const { parseNotes } = await import("./summarize");
    const deep = { text: "L1", children: [{ text: "L2", children: [{ text: "L3", children: [{ text: "L4" }] }] }] };
    const notes = parseNotes(
      JSON.stringify({
        summary: "",
        minutes: {
          attendees: ["Sharif", ""],
          topics: [{ title: " Scope Review ", points: [deep, "Rayyan agreed to follow up.", { nope: 1 }] }, { points: [] }],
        },
      }),
    );
    expect(notes.minutes).toEqual({
      attendees: ["Sharif"],
      topics: [
        {
          title: "Scope Review",
          points: [{ text: "L1", children: [{ text: "L2", children: [{ text: "L3" }] }] }, { text: "Rayyan agreed to follow up." }],
        },
      ],
    });
  });

  it("takes attendees from Meet's participant list first", async () => {
    const { withAttendees } = await import("./summarize");
    const base = { summary: "", keyPoints: [], decisions: [], actionItems: [], minutes: { attendees: ["Model guess"], topics: [] } };
    const segs = [seg(0, "Speaker 2", "x")];
    expect(withAttendees(base, ["Sharif Islam", "Rayyan"], segs).minutes!.attendees).toEqual(["Sharif Islam", "Rayyan"]);
    expect(withAttendees(base, [], segs).minutes!.attendees).toEqual(["Model guess"]);
    expect(withAttendees({ ...base, minutes: undefined }, [], segs).minutes!.attendees).toEqual(["Speaker 2"]);
  });
});

describe("speaksBangla", () => {
  it("spots Bangla from the detected language or the script", async () => {
    const { speaksBangla } = await import("./summarize");
    const line = (text: string) => ({ speaker: "Speaker 1", startMs: 0, endMs: 1, text });
    expect(speaksBangla("bn,en", [line("hello")])).toBe(true);
    expect(speaksBangla("en", [line("ঠিক আছে, let's go")])).toBe(true);
    expect(speaksBangla("en", [line("hello")])).toBe(false);
    expect(speaksBangla(null, [])).toBe(false);
  });
});
