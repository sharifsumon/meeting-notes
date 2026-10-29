"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Icon, PLATFORM, StatusPill, SUPPORTED_PLATFORMS } from "@/components/ui";
import type { MeetingRow } from "@/lib/meetings";
import { useIsClient } from "../meetings/meeting-list";
import { RecordSwitch } from "../meetings/record-switch";
import { SendBotNowButton } from "../meetings/send-bot-now";

const headFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "short", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

const href = (offset: number) => (offset === 0 ? "/calendar" : `/calendar?d=${offset}`);

/** One day's meetings as a list, with arrows (and the ← → keys) to step a day at a time. */
export function DayList({ offset, meetings }: { offset: number; meetings: MeetingRow[] }) {
  const router = useRouter();
  const isClient = useIsClient();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (e.key === "ArrowLeft") router.push(href(offset - 1));
      if (e.key === "ArrowRight") router.push(href(offset + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [offset, router]);

  if (!isClient) return null;

  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  const items = meetings.filter((m) => new Date(m.startsAt) >= day && new Date(m.startsAt) < next);

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-3 text-[28px] font-extrabold tracking-[-0.02em]">{headFmt.format(day)}</h1>
        <div className="flex gap-1.5">
          <Link href={href(offset - 1)} aria-label="Previous day" className="btn-outline w-11 px-0">
            <Icon name="chevron-left" strokeWidth={2.2} />
          </Link>
          <Link href={href(0)} className="btn-outline">
            Today
          </Link>
          <Link href={href(offset + 1)} aria-label="Next day" className="btn-outline w-11 px-0">
            <Icon name="chevron-right" strokeWidth={2.2} />
          </Link>
        </div>
      </div>

      {items.length === 0 ? (
        <p className="text-muted">No meetings on this day.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((m) => (
            <Row key={m.id} m={m} now={now} />
          ))}
        </div>
      )}
    </>
  );
}

function Row({ m, now }: { m: MeetingRow; now: Date }) {
  const start = new Date(m.startsAt);
  const minutes = Math.round((new Date(m.endsAt).getTime() - start.getTime()) / 60_000);
  const platform = m.platform ? PLATFORM[m.platform] : null;
  const ended = new Date(m.endsAt) < now;
  const supported = m.platform !== null && SUPPORTED_PLATFORMS.has(m.platform);
  const canToggle = supported && !ended && (m.status === null || m.status === "scheduled");

  return (
    <article className={`card flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5 ${platform ? "" : "opacity-60"}`}>
      <span
        aria-hidden="true"
        className="flex size-11 flex-none items-center justify-center rounded-xl text-white"
        style={{ background: platform?.dot ?? "#94a3b8" }}
      >
        <Icon name="video" size={20} strokeWidth={2.2} />
      </span>
      <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-1">
        <Link href={`/meetings/${m.id}`} className="inline-flex min-w-0 items-center gap-1 font-semibold hover:underline">
          <span className="truncate">{m.title}</span>
          <Icon name="chevron-right" size={16} className="flex-none text-muted" />
        </Link>
        <span className="truncate text-sm text-muted">
          {timeFmt.format(start)} · {minutes} min · {platform?.label ?? "No link"} · {m.calendarName}
        </span>
      </div>
      <div className="ml-auto flex flex-none flex-wrap items-center gap-2">
        <StatusPill status={m.status} recordEnabled={m.recordEnabled && !ended} hasNotes={m.hasNotes} notLetIn={m.notLetIn} />
        {canToggle && m.status === null && <SendBotNowButton meetingId={m.id} />}
        {canToggle && <RecordSwitch meetingId={m.id} enabled={m.recordEnabled} />}
      </div>
    </article>
  );
}
