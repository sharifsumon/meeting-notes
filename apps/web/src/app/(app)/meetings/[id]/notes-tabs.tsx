"use client";

import { useState } from "react";
import type { ActionItem, Minutes, MinutesPoint, NoteContent, TranscriptSegment } from "@minuteflow/db";
import { Icon } from "@/components/ui";
import { seekAudio } from "./audio-player";

type Props = {
  summary: string;
  decisions: string[];
  keyPoints: string[];
  actionItems: ActionItem[];
  /** Missing on notes written before minutes existed. */
  minutes?: Minutes;
  /** The notes in other languages; Bangla calls have "bn". */
  translations: Record<string, NoteContent>;
  segments: TranscriptSegment[];
  recorded: boolean;
  /** A transcript was saved, even if it has no lines. */
  transcribed: boolean;
};

const AVATAR = [
  "bg-sky-100 text-sky-800",
  "bg-green-100 text-green-800",
  "bg-orange-100 text-orange-800",
  "bg-violet-100 text-violet-800",
  "bg-slate-100 text-slate-700",
];

function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function NotesTabs({ translations, segments, recorded, transcribed, ...english }: Props) {
  const [tab, setTab] = useState<"summary" | "transcript" | "actions">("summary");
  const [query, setQuery] = useState("");
  const [lang, setLang] = useState<"en" | "bn">("en");
  const bangla = translations.bn;
  const { summary, decisions, keyPoints, actionItems, minutes } = lang === "bn" && bangla ? bangla : english;

  const tabs = [
    { id: "summary", label: "Summary" },
    { id: "transcript", label: "Transcript" },
    { id: "actions", label: "Meeting Minutes" },
  ] as const;

  const silent = transcribed && segments.length === 0;
  const empty = silent
    ? "No speech was detected in this recording, so there are no notes. Play the audio above to check what the bot heard."
    : recorded
      ? "Summary will appear once AI notes are switched on."
      : "Nothing here yet. Once the bot records this call, the transcript and notes will show up here.";
  const emptyTranscript = silent
    ? "No speech was detected in this recording."
    : recorded
      ? "No transcript yet. It appears here a minute or so after the call, once the recording has been transcribed."
      : empty;

  const speakers = [...new Set(segments.map((s) => s.speaker))];
  const q = query.trim().toLowerCase();
  const lines = q ? segments.filter((s) => s.text.toLowerCase().includes(q) || s.speaker.toLowerCase().includes(q)) : segments;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-2 border-b border-line">
        <div role="tablist" aria-label="Meeting notes" className="flex flex-wrap gap-1">
          {tabs.map((t) => {
            const on = t.id === tab;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setTab(t.id)}
                className={`-mb-px min-h-11 border-b-2 px-4 text-[15px] ${
                  on ? "border-accent font-semibold text-accent" : "border-transparent font-medium text-ink-3 hover:text-ink"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        {bangla && tab !== "transcript" && (
          <div
            role="group"
            aria-label="Notes language"
            className="mb-1.5 flex rounded-[10px] border border-line bg-white p-0.5 text-sm"
          >
            {(
              [
                ["en", "English"],
                ["bn", "বাংলা"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={lang === id}
                onClick={() => setLang(id)}
                className={`min-h-9 rounded-lg px-3 font-semibold ${lang === id ? "bg-accent text-white" : "text-ink-3 hover:text-ink"}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {tab === "summary" && (
        <section className="card flex flex-col gap-5 p-6">
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <Icon name="spark" size={18} className="text-orange-600" />
            Executive summary
          </h2>
          {summary ? (
            <>
              <p className="text-[15px] leading-[1.7] text-ink-2">{summary}</p>
              {decisions.length > 0 && (
                <div className="flex flex-col gap-2.5">
                  <h3 className="text-[15px] font-bold">Decisions</h3>
                  <ul className="flex list-disc flex-col gap-2 pl-5 text-[15px] leading-relaxed text-ink-2">
                    {decisions.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                </div>
              )}
              {keyPoints.length > 0 && (
                <div className="flex flex-col gap-2.5">
                  <h3 className="text-[15px] font-bold">Topics discussed</h3>
                  <div className="flex flex-wrap gap-2">
                    {keyPoints.map((k) => (
                      <span key={k} className="rounded-md bg-line-soft px-2.5 py-1 text-[13px] text-ink-2">
                        {k}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="text-[15px] leading-relaxed text-muted">{empty}</p>
          )}
        </section>
      )}

      {tab === "transcript" && (
        <section className="card flex flex-col gap-[18px] p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold">Transcript</h2>
            {segments.length > 0 && (
              <div className="field min-h-10 flex-[0_1_260px] px-3">
                <Icon name="search" size={16} className="text-muted" />
                <label htmlFor="tsearch" className="sr-only">
                  Search transcript
                </label>
                <input
                  id="tsearch"
                  type="search"
                  placeholder="Search transcript"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            )}
          </div>
          {segments.length === 0 ? (
            <p className="text-[15px] leading-relaxed text-muted">{emptyTranscript}</p>
          ) : lines.length === 0 ? (
            <p className="text-sm text-muted">No lines match “{query}”.</p>
          ) : (
            lines.map((l, i) => (
              <div key={`${l.startMs}-${i}`} className="flex items-start gap-3.5">
                <span
                  className={`flex size-8 flex-none items-center justify-center rounded-full text-xs font-bold ${
                    AVATAR[speakers.indexOf(l.speaker) % AVATAR.length]
                  }`}
                >
                  {/^speaker (\d+)$/i.exec(l.speaker)?.[1]
                    ? `S${/\d+$/.exec(l.speaker)![0]}`
                    : l.speaker.slice(0, 2).toUpperCase()}
                </span>
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex items-baseline gap-2.5">
                    <span className="text-sm font-bold">{l.speaker}</span>
                    <button
                      type="button"
                      onClick={() => seekAudio(l.startMs)}
                      aria-label={`Play from ${clock(l.startMs)}`}
                      className="text-[13px] text-accent tabular-nums hover:underline"
                    >
                      {clock(l.startMs)}
                    </button>
                  </div>
                  <p className="text-[15px] leading-relaxed text-ink-2">{l.text}</p>
                </div>
              </div>
            ))
          )}
        </section>
      )}

      {tab === "actions" && (
        <section className="card flex flex-col gap-4 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold">Meeting Minutes</h2>
            {minutes && minutes.topics.length > 0 && <CopyButton text={minutesText(minutes, actionItems)} />}
          </div>
          {minutes && minutes.topics.length > 0 ? (
            <>
              {minutes.attendees.length > 0 && (
                <p className="text-[15px] text-ink-2">
                  <span className="font-bold text-ink">Attendees:</span> {minutes.attendees.join(", ")}
                </p>
              )}
              <h3 className="text-[15px] font-bold">Discussion Points</h3>
              <ol className="flex list-decimal flex-col gap-4 pl-6 text-[15px] leading-relaxed text-ink-2 marker:font-bold">
                {minutes.topics.map((t, i) => (
                  <li key={i}>
                    <span className="font-bold text-ink">{t.title}</span>
                    <Points points={t.points} depth={0} />
                  </li>
                ))}
              </ol>
              {actionItems.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <h3 className="text-[15px] font-bold">Next steps</h3>
                  <ActionList items={actionItems} />
                </div>
              )}
            </>
          ) : actionItems.length > 0 ? (
            // Notes written before minutes existed only have action items.
            <ActionList items={actionItems} />
          ) : (
            <p className="text-[15px] leading-relaxed text-muted">
              {recorded && !silent ? "Minutes will appear once AI notes are switched on." : empty}
            </p>
          )}
        </section>
      )}
    </>
  );
}

const BULLET = ["list-disc", "list-[circle]", "list-[square]"];

function Points({ points, depth }: { points: MinutesPoint[]; depth: number }) {
  if (!points.length) return null;
  return (
    <ul className={`mt-1.5 flex flex-col gap-1.5 pl-5 ${BULLET[depth] ?? "list-disc"}`}>
      {points.map((p, i) => (
        <li key={i}>
          {p.text}
          {p.children && <Points points={p.children} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

function ActionList({ items }: { items: ActionItem[] }) {
  return items.map((x, i) => (
    <div key={i} className="flex flex-wrap items-center gap-3 border-t border-line-soft py-3">
      <span aria-hidden="true" className="size-2 flex-none rounded-full bg-green-600" />
      <p className="flex-[1_1_300px] text-[15px]">{x.text}</p>
      {x.owner && <span className="text-[13px] text-ink-3">{x.owner}</span>}
      {x.dueDate && <span className="pill bg-orange-100 text-orange-800">{x.dueDate}</span>}
    </div>
  ));
}

/** The minutes as plain text, ready to paste into an email or document. */
export function minutesText(minutes: Minutes, actionItems: ActionItem[] = []) {
  const lines = [`Attendees: ${minutes.attendees.join(", ")}`, "", "Discussion Points"];
  const add = (points: MinutesPoint[], depth: number) => {
    for (const p of points) {
      lines.push(`${"   ".repeat(depth)}* ${p.text}`);
      if (p.children) add(p.children, depth + 1);
    }
  };
  minutes.topics.forEach((t, i) => {
    lines.push(`${i + 1}. ${t.title}`);
    add(t.points, 0);
  });
  if (actionItems.length) {
    lines.push("", "Next steps");
    for (const a of actionItems) lines.push(`* ${[a.text, a.owner, a.dueDate].filter(Boolean).join(" · ")}`);
  }
  return lines.join("\n");
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn-outline"
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          },
          () => setCopied(false),
        )
      }
    >
      {copied ? "Copied" : "Copy minutes"}
    </button>
  );
}
