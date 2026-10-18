import { botSessions, calendars, meetings, notes, transcripts, users } from "@minuteflow/db";
import { and, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LocalTime } from "@/components/local-time";
import { Icon, PLATFORM, StatusPill, SUPPORTED_PLATFORMS, wasNotLetIn } from "@/components/ui";
import { db } from "@/lib/db";
import { sessionOf } from "@/lib/meetings";
import { requireUserId } from "@/lib/session";
import { RecordSwitch } from "../record-switch";
import { DeleteMeetingButton } from "../delete-meeting";
import { JoinMeetingLink, SendBotNowButton } from "../send-bot-now";
import { AudioPlayer } from "./audio-player";
import { NotesTabs } from "./notes-tabs";

const BOT_LABEL = {
  scheduled: "Will join at the start",
  joining: "Joining the call",
  waiting_room: "Waiting to be admitted",
  recording: "Recording now",
  processing: "Transcribing and writing notes",
  completed: "Done",
  failed: "Couldn't record",
  cancelled: "Skipped",
} as const;

/** "bn" → "Bangla", "en-US" → "American English", "bn,en" → "Bangla and English"; falls back to the code. */
function languageName(codes: string) {
  const name = (code: string) => {
    try {
      return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
    } catch {
      return code;
    }
  };
  return codes.split(",").map(name).join(" and ");
}

export default async function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const [row] = await db()
    .select({ meeting: meetings, calendarName: calendars.name, bot: botSessions })
    .from(meetings)
    .leftJoin(calendars, eq(meetings.calendarId, calendars.id))
    .leftJoin(botSessions, sessionOf())
    .where(and(eq(meetings.id, id), eq(meetings.userId, userId), isNull(meetings.deletedAt)))
    .limit(1);
  if (!row) notFound();
  const { meeting: m, bot } = row;
  const notLetIn = bot?.status === "failed" && wasNotLetIn(bot.error);
  // Another MinuteFlow user's bot recorded this call; name whose, since it isn't this user's bot.
  const shared = Boolean(bot && bot.meetingId !== m.id);
  const [recordedFor] = shared && bot
    ? await db()
        .select({ name: users.name })
        .from(meetings)
        .innerJoin(users, eq(users.id, meetings.userId))
        .where(eq(meetings.id, bot.meetingId))
        .limit(1)
    : [];

  const [note] = bot ? await db().select().from(notes).where(eq(notes.meetingId, bot.meetingId)).limit(1) : [];
  const [transcript] = bot
    ? await db().select().from(transcripts).where(eq(transcripts.botSessionId, bot.id)).limit(1)
    : [];

  const platform = m.platform ? PLATFORM[m.platform] : null;
  const ended = m.endsAt < new Date();
  const supported = m.platform !== null && SUPPORTED_PLATFORMS.has(m.platform);
  const hasRecording = Boolean(bot?.recordingKey) && bot?.status !== "failed" && bot?.status !== "cancelled";
  const recordedMinutes =
    bot?.joinedAt && bot.leftAt ? Math.max(1, Math.round((bot.leftAt.getTime() - bot.joinedAt.getTime()) / 60000)) : null;

  return (
    <main className="flex w-full max-w-[1120px] flex-col gap-5 px-4 pt-6 pb-12 md:px-8">
      <Link href="/meetings" className="inline-flex min-h-9 items-center gap-1.5 self-start text-sm font-semibold text-accent hover:text-sky-800">
        <Icon name="back" size={16} strokeWidth={2.2} />
        Back to meetings
      </Link>

      <section className="card flex flex-col gap-[18px] p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill status={bot?.status ?? null} recordEnabled={m.recordEnabled && !ended} hasNotes={Boolean(note)} notLetIn={notLetIn} />
              <span className="pill border border-accent-soft bg-sky-50 font-medium text-accent">
                {row.calendarName ?? "Sent from a link"}
              </span>
              {shared && (
                <span className="pill border border-line bg-page font-medium text-ink-3">
                  Recorded by {recordedFor?.name ?? "another MinuteFlow user"}&apos;s notetaker
                </span>
              )}
            </div>
            <h1 className="text-[28px] font-extrabold tracking-[-0.02em] break-words">{m.title}</h1>
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-ink-3">
              <span className="inline-flex items-center gap-1.5">
                <Icon name="calendar" size={16} className="text-muted" />
                <LocalTime iso={m.startsAt.toISOString()} format="day" />
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Icon name="clock" size={16} className="text-muted" />
                <LocalTime iso={m.startsAt.toISOString()} format="time" /> – <LocalTime iso={m.endsAt.toISOString()} format="time" />
                {recordedMinutes && ` · ${recordedMinutes} min recorded`}
              </span>
              {platform && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ background: platform.dot }} />
                  {platform.label}
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {supported && !ended && (!bot || bot.status === "scheduled") && (
              <RecordSwitch meetingId={m.id} enabled={m.recordEnabled} label="Send notetaker" />
            )}
            {supported && !ended && (!bot || (bot.status === "scheduled" && !shared && !m.botRequestedAt)) && (
              <SendBotNowButton meetingId={m.id} />
            )}
            {m.meetingUrl && !ended && (
              <JoinMeetingLink meetingId={m.id} url={m.meetingUrl} sendBot={supported && !bot && m.recordEnabled} />
            )}
            {hasRecording && bot && (
              <a href={`/api/recordings/${bot.id}?download=1`} className="btn-outline">
                <Icon name="download" size={17} />
                Download audio
              </a>
            )}
            {/* Deleting a shared meeting only removes this user's copy, so it's never blocked by the bot. */}
            {(shared || !(bot && ["joining", "waiting_room", "recording"].includes(bot.status))) && (
              <DeleteMeetingButton meetingId={m.id} title={m.title} redirectTo="/meetings" />
            )}
          </div>
        </div>
      </section>

      {hasRecording && bot && <AudioPlayer src={`/api/recordings/${bot.id}`} minutes={recordedMinutes} />}

      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-5">
          <NotesTabs
            summary={note?.summary ?? ""}
            decisions={note?.decisions ?? []}
            keyPoints={note?.keyPoints ?? []}
            actionItems={note?.actionItems ?? []}
            minutes={note?.minutes ?? undefined}
            translations={note?.translations ?? {}}
            segments={transcript?.segments ?? []}
            recorded={hasRecording}
            transcribed={!!transcript}
          />
        </div>
        <aside className="flex min-w-0 flex-[1_1_280px] flex-col gap-5">
          {!hasRecording && (
            <section className="card flex flex-col gap-3.5 p-5">
              <h2 className="text-[15px] font-bold">Meeting audio</h2>
              <p className="text-sm leading-relaxed text-muted">
                {notLetIn
                  ? "The bot wasn't let into this call."
                  : bot?.status === "failed"
                  ? "The bot couldn't record this call."
                  : ended
                    ? "This call wasn't recorded."
                    : "The recording appears here once the bot has been in the call."}
              </p>
            </section>
          )}
          <section className="card flex flex-col gap-3 p-5">
            <h2 className="text-[15px] font-bold">Details</h2>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm [&_dd]:break-words">
              <dt className="text-muted">Source</dt>
              <dd>{platform?.label ?? "No video link"}</dd>
              <dt className="text-muted">Calendar</dt>
              <dd>{row.calendarName ?? "Sent from a link"}</dd>
              <dt className="text-muted">Notetaker</dt>
              <dd>{notLetIn ? "Not allowed in" : bot ? BOT_LABEL[bot.status] : m.recordEnabled && !ended ? "Will join at the start" : "Off"}</dd>
              {transcript?.language && (
                <>
                  <dt className="text-muted">Language</dt>
                  <dd>{languageName(transcript.language)}</dd>
                </>
              )}
              {bot?.joinedAt && (
                <>
                  <dt className="text-muted">Joined</dt>
                  <dd>
                    <LocalTime iso={bot.joinedAt.toISOString()} format="time" />
                  </dd>
                </>
              )}
              {bot?.leftAt && (
                <>
                  <dt className="text-muted">Left</dt>
                  <dd>
                    <LocalTime iso={bot.leftAt.toISOString()} format="time" />
                  </dd>
                </>
              )}
            </dl>
            {(bot?.status === "failed" || bot?.status === "cancelled") && bot.error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{bot.error}</p>}
          </section>
        </aside>
      </div>
    </main>
  );
}
