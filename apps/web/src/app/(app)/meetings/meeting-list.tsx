"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { Icon, PlatformChip, StatusPill, SUPPORTED_PLATFORMS } from "@/components/ui";
import type { MeetingRow } from "@/lib/meetings";
import { RecordSwitch } from "./record-switch";

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
const longDayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

const subscribeNoop = () => () => {};

/** Dates are shown in the viewer's time zone, which the server doesn't know: render on the client only. */
export function useIsClient() {
  return useSyncExternalStore(subscribeNoop, () => true, () => false);
}

function dayKey(d: Date) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(d: Date) {
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(d) === dayKey(today)) return "Today";
  if (dayKey(d) === dayKey(tomorrow)) return "Tomorrow";
  if (dayKey(d) === dayKey(yesterday)) return "Yesterday";
  return dayFmt.format(d);
}

export function TodayLine({ meetings }: { meetings: MeetingRow[] }) {
  const isClient = useIsClient();
  if (!isClient) return <p className="mt-1.5 text-[15px] text-muted">&nbsp;</p>;
  const today = dayKey(new Date());
  const n = meetings.filter((m) => dayKey(new Date(m.startsAt)) === today).length;
  return (
    <p className="mt-1.5 text-[15px] text-muted">
      {longDayFmt.format(new Date())}
      {meetings.length > 0 && ` · ${n === 0 ? "no" : n} meeting${n === 1 ? "" : "s"} today`}
    </p>
  );
}

export function MeetingList({ meetings }: { meetings: MeetingRow[] }) {
  const isClient = useIsClient();
  if (!isClient) return null;

  const groups = new Map<string, { label: string; items: MeetingRow[] }>();
  for (const m of meetings) {
    const d = new Date(m.startsAt);
    const key = dayKey(d);
    const g = groups.get(key) ?? { label: dayLabel(d), items: [] };
    g.items.push(m);
    groups.set(key, g);
  }

  return (
    <div className="flex flex-col gap-6">
      {[...groups].map(([key, g]) => (
        <section key={key} aria-labelledby={`day-${key}`} className="flex flex-col gap-3">
          <h2 id={`day-${key}`} className="section-label">
            {g.label}
          </h2>
          {g.items.map((m) => (
            <MeetingCard key={m.id} meeting={m} />
          ))}
        </section>
      ))}
    </div>
  );
}

function MeetingCard({ meeting: m }: { meeting: MeetingRow }) {
  const supported = m.platform !== null && SUPPORTED_PLATFORMS.has(m.platform);
  const ended = new Date(m.endsAt) < new Date();
  // The switch only makes sense before the bot has started.
  const canToggle = supported && !ended && (m.status === null || m.status === "scheduled");

  return (
    <article className="card flex flex-wrap items-center gap-x-6 gap-y-4 px-5 py-[18px]">
      <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <h3 className="text-[17px] font-bold tracking-[-0.01em]">
            <Link href={`/meetings/${m.id}`} className="hover:underline">
              {m.title}
            </Link>
          </h3>
          <PlatformChip platform={m.platform} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className="pill border border-accent-soft bg-sky-50 font-medium text-accent">{m.calendarName}</span>
          <StatusPill status={m.status} recordEnabled={m.recordEnabled && !ended} />
          {m.platform && !supported && <span className="pill bg-slate-100 font-medium text-muted">Bot coming soon</span>}
        </div>
      </div>
      <span className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap text-ink-2">
        <Icon name="clock" size={16} className="text-muted" />
        {timeFmt.format(new Date(m.startsAt))} – {timeFmt.format(new Date(m.endsAt))}
      </span>
      <div className="ml-auto flex flex-none flex-wrap items-center gap-2">
        {canToggle && <RecordSwitch meetingId={m.id} enabled={m.recordEnabled} />}
        <Link href={`/meetings/${m.id}`} className="btn-dark">
          Open Details
        </Link>
      </div>
    </article>
  );
}
