import {
  botSessions,
  meetings,
  notes,
  transcripts,
  type ActionItem,
  type Minutes,
  type MinutesPoint,
  type NoteContent,
  type TranscriptSegment,
} from "@minuteflow/db";
import { and, eq, inArray, isNull, like, not, or, sql } from "drizzle-orm";
import { config } from "./config";
import { db } from "./db";
import { dedupeNames, isBotName } from "./meet/names";

export type MeetingNotes = NoteContent;

/** Writes notes from a transcript. Swap the implementation to change model or provider. */
export interface Summarizer {
  readonly name: string;
  summarize(input: { title: string; segments: TranscriptSegment[]; participants?: string[]; language?: string }): Promise<MeetingNotes>;
  /** The same notes in another language, e.g. "Bangla". */
  translate(notes: MeetingNotes, language: string): Promise<MeetingNotes>;
}


function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Rough token count: about four Latin characters per token, but Bangla and other scripts take
 * about one token per character.
 */
export function estimateTokens(text: string) {
  const ascii = text.replace(/[^\x00-\x7F]/g, "").length;
  return Math.ceil(ascii / 4) + (text.length - ascii);
}

/** Transcript as "[m:ss] Speaker: text" lines, split so each chunk stays under maxTokens. */
export function transcriptChunks(segments: TranscriptSegment[], maxTokens: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let tokens = 0;
  for (const s of segments) {
    const line = `[${clock(s.startMs)}] ${s.speaker}: ${s.text}\n`;
    const lineTokens = estimateTokens(line);
    if (current && tokens + lineTokens > maxTokens) {
      chunks.push(current);
      current = "";
      tokens = 0;
    }
    current += line;
    tokens += lineTokens;
  }
  if (current) chunks.push(current);
  return chunks;
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);

const MAX_DEPTH = 3;

function points(v: unknown, depth = 1): MinutesPoint[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((p): MinutesPoint[] => {
    // Models sometimes answer with plain strings for leaf bullets.
    if (typeof p === "string") return p.trim() ? [{ text: p.trim() }] : [];
    if (!p || typeof p !== "object" || typeof (p as { text?: unknown }).text !== "string") return [];
    const { text, children } = p as { text: string; children?: unknown };
    const kids = depth < MAX_DEPTH ? points(children, depth + 1) : [];
    return text.trim() ? [{ text: text.trim(), ...(kids.length ? { children: kids } : {}) }] : [];
  });
}

export function parseMinutes(v: unknown): Minutes | undefined {
  if (!v || typeof v !== "object") return undefined;
  const { attendees, topics } = v as { attendees?: unknown; topics?: unknown };
  return {
    attendees: strings(attendees),
    topics: (Array.isArray(topics) ? topics : []).flatMap((t) => {
      if (!t || typeof t !== "object" || typeof (t as { title?: unknown }).title !== "string") return [];
      const { title, points: p } = t as { title: string; points?: unknown };
      return title.trim() ? [{ title: title.trim(), points: points(p) }] : [];
    }),
  };
}

/** Validates the model's JSON loosely: anything missing becomes empty rather than failing the meeting. */
export function parseNotes(raw: string): MeetingNotes {
  // Outside JSON mode the model may wrap the object in a sentence or a code fence.
  const json = raw.trim().startsWith("{") ? raw : raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  const v = JSON.parse(json) as Record<string, unknown>;
  const items = Array.isArray(v.actionItems) ? v.actionItems : [];
  const minutes = parseMinutes(v.minutes);
  return {
    ...(minutes ? { minutes } : {}),
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
{"summary": "one paragraph, 3-6 sentences", "keyPoints": ["short topic", ...], "decisions": ["decision", ...], "actionItems": [{"text": "what needs doing", "owner": "who, if said", "due": "when, if said"}],
 "minutes": {"attendees": ["name", ...], "topics": [{"title": "Topic title", "points": [{"text": "bullet", "children": [{"text": "sub-bullet", "children": [{"text": "sub-sub-bullet"}]}]}]}]}}
Only include decisions and action items that were actually stated. Use [] when there are none. Speakers are labelled "Speaker 1", "Speaker 2"; use real names only where the transcript says them.
"minutes" are formal meeting minutes. Group the discussion into numbered topics in the order they came up, each with a short descriptive title (for example "Scope Review", "Delivery Planning", "Weekly Project Meeting"). Write every bullet in the third person, past tense and a formal tone, naming who said, raised, clarified, confirmed or agreed to what (for example "Sharif confirmed that the team will prioritize the booking flow." or "Rayyan agreed to look for the old credentials and share them if found."). Cover agreements and who will follow up, and any timelines, dates and recurring meetings. Use "children" for supporting detail, at most three levels deep. "attendees" lists everyone who took part.`;

/**
 * Attendees come from Meet's participant list when the bot saw it; otherwise the model's
 * list, or the transcript's speaker labels.
 */
export function withAttendees(notes: MeetingNotes, participants: string[], segments: TranscriptSegment[]): MeetingNotes {
  const minutes = notes.minutes ?? { attendees: [], topics: [] };
  const attendees = participants.length
    ? participants
    : minutes.attendees.length
      ? minutes.attendees
      : [...new Set(segments.map((s) => s.speaker))];
  return { ...notes, minutes: { ...minutes, attendees } };
}

/** Groups notes in order so each group's JSON stays under maxTokens, at least two to a group. */
export function notesBatches(parts: MeetingNotes[], maxTokens: number): MeetingNotes[][] {
  const batches: MeetingNotes[][] = [];
  let tokens = 0;
  for (const part of parts) {
    const t = estimateTokens(JSON.stringify(part));
    const last = batches[batches.length - 1];
    if (last && (last.length < 2 || tokens + t <= maxTokens)) {
      last.push(part);
      tokens += t;
    } else {
      batches.push([part]);
      tokens = t;
    }
  }
  return batches;
}

/** OpenAI-compatible chat completions with JSON output, retrying rate limits. */
export function groq(apiKey: string, model: string): Summarizer {
  async function complete(system: string, user: string): Promise<string> {
    // Groq checks JSON mode replies and rejects the whole reply over one slip, which long notes
    // sometimes hit. After two of those, ask without JSON mode; parseNotes copes with stray text.
    let jsonMode = true;
    let jsonFailures = 0;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
          messages: [
            { role: "system", content: jsonMode ? system : `${system}\nReply with the JSON object only.` },
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
      if (!res.ok) {
        const error = (await res.text()).slice(0, 300);
        if (res.status === 400 && /json_validate_failed|failed to validate json/i.test(error) && jsonFailures < 2) {
          if (++jsonFailures === 2) jsonMode = false;
          continue;
        }
        throw new Error(`Groq returned ${res.status}: ${error}`);
      }
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
      // Small chunks keep each request inside Groq's tokens-per-minute limit (8k for gpt-oss-120b
      // on demand), counting the instructions and the reply too.
      const chunks = transcriptChunks(segments, 3_500);
      if (chunks.length === 1) {
        return withAttendees(parseNotes(await complete(system, `${header}\n\nTranscript:\n${chunks[0]}`)), participants, segments);
      }
      const parts: MeetingNotes[] = [];
      for (const [i, chunk] of chunks.entries()) {
        parts.push(
          parseNotes(
            await complete(system, `${header}\nPart ${i + 1} of ${chunks.length} of the transcript:\n${chunk}`),
          ),
        );
      }
      const merge = async (batch: MeetingNotes[]) =>
        parseNotes(
          await complete(
            `You merge partial meeting notes into one set of notes, removing duplicates and joining topics that continue across parts. ${NOTES_SHAPE}\n${writeIn}`,
            `Meeting: ${title}\nNotes for each part, in order:\n${JSON.stringify(batch)}`,
          ),
        );
      // A long call's notes can be too big to merge at once, so merge them a few at a time.
      let merged = parts;
      while (merged.length > 1) {
        const batches = notesBatches(merged, 3_500);
        merged = [];
        for (const batch of batches) merged.push(batch.length === 1 ? batch[0]! : await merge(batch));
        if (batches.length === 1) break;
      }
      return withAttendees(merged[0]!, participants, segments);
    },
    async translate(notes, language) {
      const { summary, keyPoints, decisions, actionItems, minutes } = notes;
      return parseNotes(
        await complete(
          `You translate meeting notes into ${language}. Keep people's names, product names and technical terms as they are. ${NOTES_SHAPE}`,
          JSON.stringify({
            summary,
            keyPoints,
            decisions,
            actionItems: actionItems.map(({ text, owner, dueDate }) => ({ text, owner, due: dueDate })),
            minutes,
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
      // Sessions recorded before the bot left itself out list it as a participant.
      const participants = dedupeNames(s.participants.filter((n) => !isBotName(n, [config.BOT_ACCOUNT_NAME])));
      // Notes are in English, with a Bangla copy when NOTES_BANGLA is on.
      const result = await provider.summarize({ title: s.title, segments: s.segments, participants, language: "English" });
      const translations: Record<string, MeetingNotes> =
        config.NOTES_BANGLA === "true" ? { bn: await provider.translate(result, "Bangla (বাংলা)") } : {};
      await db
        .insert(notes)
        .values({ meetingId: s.meetingId, ...result, minutes: result.minutes ?? null, translations })
        .onConflictDoNothing();
      await db.update(botSessions).set({ status: "completed" }).where(eq(botSessions.id, s.sessionId));
      log(
        `Saved notes (${result.minutes?.topics.length ?? 0} topics, ${result.decisions.length} decisions, ${result.actionItems.length} action items)`,
      );
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
