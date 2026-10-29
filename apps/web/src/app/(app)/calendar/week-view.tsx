"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { Icon, PLATFORM, StatusPill, SUPPORTED_PLATFORMS } from "@/components/ui";
import type { MeetingRow } from "@/lib/meetings";
import { RecordSwitch } from "../meetings/record-switch";

const HOUR_PX = 96;
const subscribeNoop = () => () => {};

const monthFmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const dowFmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "short", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const hourFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric" });

function startOfWeek(d: Date) {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const offset = (day.getDay() + 6) % 7; // Monday first
  day.setDate(day.getDate() - offset);
  return day;
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Hours since local midnight of `day`, clamped to that day. */
function hoursInto(day: Date, t: Date) {
  return Math.max(0, Math.min(24, (t.getTime() - day.getTime()) / 3_600_000));
}

type Placed = { m: MeetingRow; top: number; bottom: number; lane: number; lanes: number };

/** Lays out one day's meetings side by side where they overlap. */
function place(day: Date, items: MeetingRow[]): Placed[] {
  const placed: Placed[] = items
    .map((m) => {
      const top = hoursInto(day, new Date(m.startsAt));
      return { m, top, bottom: Math.max(hoursInto(day, new Date(m.endsAt)), top + 0.25), lane: 0, lanes: 1 };
    })
    .sort((a, b) => a.top - b.top);

  let cluster: Placed[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const ends: number[] = [];
    for (const p of cluster) {
      let lane = ends.findIndex((end) => end <= p.top);
      if (lane === -1) lane = ends.length;
      ends[lane] = p.bottom;
      p.lane = lane;
    }
    for (const p of cluster) p.lanes = ends.length;
    cluster = [];
  };
  for (const p of placed) {
    if (p.top >= clusterEnd) flush();
    cluster.push(p);
    clusterEnd = Math.max(clusterEnd, p.bottom);
  }
  flush();
  return placed;
}

export function WeekView({ view, offset, meetings }: { view: "day" | "week"; offset: number; meetings: MeetingRow[] }) {
  const isClient = useSyncExternalStore(subscribeNoop, () => true, () => false);
  const [selectedId, setSelectedId] = useState<string>();
  if (!isClient) return null;

  const now = new Date();
  const isDay = view === "day";
  const monday = isDay
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
    : startOfWeek(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset * 7));
  const days = Array.from({ length: isDay ? 1 : 7 }, (_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i));
  const weekEnd = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + days.length);
  const step = (n: number) => (isDay ? `/calendar?view=day&d=${n}` : `/calendar?w=${n}`);

  const inWeek = meetings.filter((m) => new Date(m.startsAt) < weekEnd && new Date(m.endsAt) > monday);
  const byDay = days.map((d) => place(d, inWeek.filter((m) => sameDay(new Date(m.startsAt), d))));

  // Show 8:00–19:00, stretched to fit anything earlier or later.
  let first = 8;
  let last = 19;
  for (const day of byDay) {
    for (const p of day) {
      first = Math.min(first, Math.floor(p.top));
      last = Math.max(last, Math.ceil(p.bottom));
    }
  }
  const hours = Array.from({ length: last - first }, (_, i) => first + i);
  const height = (last - first) * HOUR_PX;

  const selected =
    inWeek.find((m) => m.id === selectedId) ?? inWeek.find((m) => new Date(m.endsAt) > now) ?? inWeek[0];

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-3 text-[28px] font-extrabold tracking-[-0.02em]">
          {isDay ? dayFmt.format(days[0]!) : monthFmt.format(days[3]!)}
        </h1>
        <div className="flex gap-1.5">
          <Link href={step(offset - 1)} aria-label={isDay ? "Previous day" : "Previous week"} className="btn-outline w-11 px-0">
            <Icon name="chevron-left" strokeWidth={2.2} />
          </Link>
          <Link href={step(0)} className="btn-outline">
            Today
          </Link>
          <Link href={step(offset + 1)} aria-label={isDay ? "Next day" : "Next week"} className="btn-outline w-11 px-0">
            <Icon name="chevron-right" strokeWidth={2.2} />
          </Link>
        </div>
        <div className="flex rounded-xl border border-line p-0.5 text-sm font-semibold">
          {(["day", "week"] as const).map((v) => (
            <Link
              key={v}
              href={v === "day" ? "/calendar?view=day" : "/calendar"}
              aria-current={v === view ? "page" : undefined}
              className={`rounded-[10px] px-3.5 py-1.5 ${v === view ? "bg-ink text-white" : "text-ink-3 hover:text-ink"}`}
            >
              {v === "day" ? "Day" : "Week"}
            </Link>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-3.5 text-[13px] text-ink-3">
          {(["google_meet", "zoom", "microsoft_teams"] as const).map((p) => (
            <span key={p} className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-[3px]" style={{ background: PLATFORM[p].dot }} />
              {PLATFORM[p].label}
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <div className="card min-w-0 flex-[999_1_600px] overflow-x-auto">
          <div className={`grid ${isDay ? "grid-cols-[56px_minmax(0,1fr)]" : "min-w-[900px] grid-cols-[56px_repeat(7,minmax(0,1fr))]"}`}>
            <div className="border-b border-line" />
            {days.map((d) => {
              const today = sameDay(d, now);
              return (
                <div
                  key={d.toISOString()}
                  className={`border-b border-l border-line border-l-line-soft px-2 py-3 text-center ${today ? "bg-sky-50 text-accent" : "text-ink-3"}`}
                >
                  <div className="text-xs font-semibold tracking-[0.05em] uppercase">{dowFmt.format(d)}</div>
                  <div className={`mt-0.5 text-xl font-bold ${today ? "" : "text-ink"}`}>{d.getDate()}</div>
                </div>
              );
            })}
            <div className="relative" style={{ height }}>
              {hours.map((h, i) => (
                <span key={h} className="absolute right-2 -translate-y-1.5 text-[11px] text-muted" style={{ top: i * HOUR_PX }}>
                  {i === 0 ? "" : hourFmt.format(new Date(2000, 0, 1, h))}
                </span>
              ))}
            </div>
            {days.map((d, di) => (
              <div
                key={d.toISOString()}
                className={`relative border-l border-line-soft ${sameDay(d, now) ? "bg-sky-50/40" : ""}`}
                style={{
                  height,
                  backgroundImage: `repeating-linear-gradient(to bottom, #eef2f6 0, #eef2f6 1px, transparent 1px, transparent ${HOUR_PX}px)`,
                }}
              >
                {byDay[di]!.map((p) => {
                  const platform = p.m.platform ? PLATFORM[p.m.platform] : PLATFORM.other;
                  const on = p.m.id === selected?.id;
                  return (
                    <button
                      key={p.m.id}
                      type="button"
                      onClick={() => setSelectedId(p.m.id)}
                      aria-label={`${p.m.title}, ${timeFmt.format(new Date(p.m.startsAt))}`}
                      aria-pressed={on}
                      title={`${p.m.title}\n${timeFmt.format(new Date(p.m.startsAt))} – ${timeFmt.format(new Date(p.m.endsAt))}`}
                      className={`absolute flex flex-col gap-0.5 overflow-hidden rounded-lg border px-1.5 py-1 text-left ${platform.tint} ${
                        on ? "z-10 ring-2 ring-ink" : ""
                      }`}
                      style={{
                        top: (p.top - first) * HOUR_PX + 1,
                        height: (p.bottom - p.top) * HOUR_PX - 2,
                        left: `calc(${(p.lane / p.lanes) * 100}% + 3px)`,
                        width: `calc(${100 / p.lanes}% - 6px)`,
                      }}
                    >
                      {p.bottom - p.top < 0.6 ? (
                        <span className="flex items-baseline gap-1.5 truncate text-xs leading-tight">
                          <span className="truncate font-bold">{p.m.title}</span>
                          <span className="flex-none text-[11px]">{timeFmt.format(new Date(p.m.startsAt))}</span>
                        </span>
                      ) : (
                        <>
                          <span className="flex items-center gap-1 text-[10px] font-bold tracking-[0.04em] uppercase">
                            <span className="size-1.5 flex-none rounded-full" style={{ background: platform.dot }} />
                            <span className="truncate">{p.m.platform ? platform.label : "No link"}</span>
                          </span>
                          <span className="max-w-full truncate text-[13px] leading-tight font-bold">{p.m.title}</span>
                          <span className="truncate text-[11px]">
                            {timeFmt.format(new Date(p.m.startsAt))} – {timeFmt.format(new Date(p.m.endsAt))}
                          </span>
                        </>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <aside className="card flex min-w-0 flex-[1_1_280px] flex-col gap-4 p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_rgba(15,23,42,0.06)]">
          {selected ? <Selected key={selected.id} m={selected} now={now} /> : <p className="text-sm text-muted">{isDay ? "No meetings this day." : "No meetings this week."}</p>}
        </aside>
      </div>
    </>
  );
}

function Selected({ m, now }: { m: MeetingRow; now: Date }) {
  const platform = m.platform ? PLATFORM[m.platform] : null;
  const ended = new Date(m.endsAt) < now;
  const supported = m.platform !== null && SUPPORTED_PLATFORMS.has(m.platform);
  const canToggle = supported && !ended && (m.status === null || m.status === "scheduled");

  return (
    <>
      <div className="flex items-center gap-2 text-[13px] font-semibold text-ink-2">
        <span className="size-2.5 rounded-[3px]" style={{ background: platform?.dot ?? "#94a3b8" }} />
        {platform?.label ?? "No video link"}
        <span className="ml-auto">
          <StatusPill status={m.status} recordEnabled={m.recordEnabled && !ended} hasNotes={m.hasNotes} notLetIn={m.notLetIn} />
        </span>
      </div>
      <h2 className="text-xl font-extrabold tracking-[-0.01em] break-words">{m.title}</h2>
      <div className="flex flex-col gap-2 text-sm text-ink-3">
        <span className="inline-flex items-center gap-2">
          <Icon name="calendar" size={16} className="text-muted" />
          {dayFmt.format(new Date(m.startsAt))}
        </span>
        <span className="inline-flex items-center gap-2">
          <Icon name="clock" size={16} className="text-muted" />
          {timeFmt.format(new Date(m.startsAt))} – {timeFmt.format(new Date(m.endsAt))}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <span className="pill border border-accent-soft bg-sky-50 font-medium text-accent">{m.calendarName}</span>
      </div>
      {canToggle && (
        <div className="[&>div]:items-stretch [&_label]:justify-between">
          <RecordSwitch meetingId={m.id} enabled={m.recordEnabled} label="Send notetaker to record" />
        </div>
      )}
      {m.platform && !supported && <p className="text-sm text-muted">The notetaker can join Google Meet calls for now.</p>}
      {m.meetingUrl && !ended && (
        <a href={m.meetingUrl} target="_blank" rel="noreferrer" className="btn-cta min-h-12">
          <Icon name="video" size={18} strokeWidth={2.2} />
          Join Meeting
        </a>
      )}
      <Link href={`/meetings/${m.id}`} className="btn-outline">
        Open Details
      </Link>
    </>
  );
}
