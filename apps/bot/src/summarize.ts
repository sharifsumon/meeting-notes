import { botSessions, meetings, notes, transcripts, type ActionItem, type NoteContent, type TranscriptSegment } from "@minuteflow/db";
import { and, eq, inArray, isNull, like, not, or, sql } from "drizzle-orm";
import { config } from "./config";
import { db } from "./db";

export type MeetingNotes = NoteContent;

/** Writes notes from a transcript. Swap the implementation to change model or provider. */
export interface Summarizer {
  readonly name: string;
  summarize(input: { title: string; segments: TranscriptSegment[]; participants?: string[]; language?: string }): Promise<MeetingNotes>;
  /** The same notes in another language, e.g. "Bangla". */
  translate(notes: MeetingNotes, language: string): Promise<MeetingNotes>;
}

/** Calls with any Bangla get notes in English and in Bangla. */
export function speaksBangla(language: string | null, segments: TranscriptSegment[]) {
  return Boolean(language?.split(",").some((l) => l.startsWith("bn"))) || segments.some((s) => /[\u0980-\u09FF]/.test(s.text));
}

function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Transcript as "[m:ss] Speaker: text" lines, split so each chunk stays under maxChars. */
export function transcriptChunks(segments: TranscriptSegment[], maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const s of segments) {
    const line = `[${clock(s.startMs)}] ${s.speaker}: ${s.text}\n`;
    if (current && current.length + line.length > maxChars) {
      chunks.push(current);
      current = "";
    }
    current += line;
  }
  if (current) chunks.push(current);
  return chunks;
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);

/** Validates the model's JSON loosely: anything missing becomes empty rather than failing the meeting. */
export function parseNotes(raw: string): MeetingNotes {
  const v = JSON.parse(raw) as Record<string, unknown>;
  const items = Array.isArray(v.actionItems) ? v.actionItems : [];
  return {
    summary: typeof v.summary === "string" ? v.summary.trim() : "",
    keyPoints: strings(v.keyPoints),
    decisions: strings(v.decisions),
    actionItems: items.flatMap((i): ActionItem[] => {
      if (!i || typeof i !== "object" || typeof (i as { text?: unknown }).text !== "string") return [];
      const { text, owner, due } = i as { text: string; owner?: unknown; due?: unknown };
      return [
        {
          text: text.trim(),
          ...(typeof owner === "string" && owner.trim() ? { owner: owner.trim() } : {}),
          ...(typeof due === "string" && due.trim() ? { dueDate: due.trim() } : {}),
        },
      ];
    }),
  };
}

const NOTES_SHAPE = `Reply with JSON only, in this shape:
{"summary": "one paragraph, 3-6 sentences", "keyPoints": ["short topic", ...], "decisions": ["decision", ...], "actionItems": [{"text": "what needs doing", "owner": "who, if said", "due": "when, if said"}]}
Only include decisions and action items that were actually stated. Use [] when there are none. Speakers are labelled "Speaker 1", "Speaker 2"; use real names only where the transcript says them.`;

/** OpenAI-compatible chat completions with JSON output, retrying rate limits. */
export function groq(apiKey: string, model: string): Summarizer {
  async function complete(system: string, user: string): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 5_000;
        await new Promise((r) => setTimeout(r, Math.min(waitMs, 120_000)));
        continue;
      }
      if (!res.ok) throw new Error(`Groq returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error("Groq returned no content");
      return content;
    }
  }

  return {
    name: `Groq (${model})`,
    async summarize({ title, segments, participants = [], language }) {
      // Names help the model attribute action items when the transcript only numbers speakers.
      const header = participants.length ? `Meeting: ${title}\nPeople in the call: ${participants.join(", ")}` : `Meeting: ${title}`;
      const writeIn = language ? `Write the notes in ${language}, whatever languages the meeting used.` : "Use the language of the meeting.";
      const system = `You write concise, accurate meeting notes from transcripts. ${NOTES_SHAPE}\n${writeIn}`;
      // Small chunks keep each request inside Groq's free-tier tokens-per-minute limit.
      const chunks = transcriptChunks(segments, 20_000);
      if (chunks.length === 1) {
        return parseNotes(await complete(system, `${header}\n\nTranscript:\n${chunks[0]}`));
      }
      const parts: MeetingNotes[] = [];
      for (const [i, chunk] of chunks.entries()) {
        parts.push(
          parseNotes(
            await complete(system, `${header}\nPart ${i + 1} of ${chunks.length} of the transcript:\n${chunk}`),
          ),
        );
      }
      return parseNotes(
        await complete(
          `You merge partial meeting notes into one set of notes, removing duplicates. ${NOTES_SHAPE}\n${writeIn}`,
          `Meeting: ${title}\nNotes for each part, in order:\n${JSON.stringify(parts)}`,
        ),
      );
    },
    async translate(notes, language) {
      const { summary, keyPoints, decisions, actionItems } = notes;
      return parseNotes(
        await complete(
          `You translate meeting notes into ${language}. Keep people's names, product names and technical terms as they are. ${NOTES_SHAPE}`,
          JSON.stringify({
            summary,
            keyPoints,
            decisions,
            actionItems: actionItems.map(({ text, owner, dueDate }) => ({ text, owner, due: dueDate })),
          }),
        ),
      );
    },
  };
}

export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";

/** The configured summarizer, or null when no key is set. */
export function summarizer(): Summarizer | null {
  return config.GROQ_API_KEY ? groq(config.GROQ_API_KEY, config.GROQ_MODEL ?? DEFAULT_GROQ_MODEL) : null;
}

const FAILED_PREFIX = "Summary failed";
const attempts = new Map<string, number>();
const MAX_ATTEMPTS = 3;

/** Writes notes for transcribed sessions that don't have them yet, then marks the session done. */
export async function summarizePending(provider: Summarizer) {
  const pending = await db
    .select({
      sessionId: botSessions.id,
      meetingId: meetings.id,
      title: meetings.title,
      participants: botSessions.participants,
      segments: transcripts.segments,
      language: transcripts.language,
    })
    .from(botSessions)
    .innerJoin(transcripts, eq(transcripts.botSessionId, botSessions.id))
    .innerJoin(meetings, eq(meetings.id, botSessions.meetingId))
    .leftJoin(notes, eq(notes.meetingId, meetings.id))
    .where(
      and(
        inArray(botSessions.status, ["processing", "completed"]),
        isNull(notes.id),
        sql`jsonb_array_length(${transcripts.segments}) > 0`,
        or(isNull(botSessions.error), not(like(botSessions.error, `${FAILED_PREFIX}%`))),
      ),
    )
    .limit(3);

  for (const s of pending) {
    const log = (msg: string) => console.log(`[summarize ${s.sessionId}] ${msg}`);
    try {
      log(`Summarizing ${s.segments.length} segments with ${provider.name}`);
      const bilingual = speaksBangla(s.language, s.segments);
      const input = { title: s.title, segments: s.segments, participants: s.participants };
      const result = await provider.summarize(bilingual ? { ...input, language: "English" } : input);
      const translations: Record<string, MeetingNotes> = bilingual ? { bn: await provider.translate(result, "Bangla (বাংলা)") } : {};
      await db
        .insert(notes)
        .values({ meetingId: s.meetingId, ...result, translations })
        .onConflictDoNothing();
      await db.update(botSessions).set({ status: "completed" }).where(eq(botSessions.id, s.sessionId));
      log(`Saved notes (${result.decisions.length} decisions, ${result.actionItems.length} action items)`);
      attempts.delete(s.sessionId);
    } catch (err) {
      const n = (attempts.get(s.sessionId) ?? 0) + 1;
      attempts.set(s.sessionId, n);
      log(`Attempt ${n} failed: ${err}`);
      if (n >= MAX_ATTEMPTS) {
        await db
          .update(botSessions)
          .set({ status: "completed", error: `${FAILED_PREFIX}: ${String(err).slice(0, 300)}` })
          .where(eq(botSessions.id, s.sessionId));
        attempts.delete(s.sessionId);
      }
    }
  }
}
