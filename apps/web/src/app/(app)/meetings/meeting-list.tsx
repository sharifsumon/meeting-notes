"use client";

import { useOptimistic, useState, useSyncExternalStore, useTransition } from "react";
import type { MeetingPlatform } from "@/lib/meeting-links";
import { setRecordEnabled } from "../actions";

export type MeetingRow = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  meetingUrl: string | null;
  platform: MeetingPlatform | null;
  recordEnabled: boolean;
  calendarName: string;
};

const PLATFORM_LABEL: Record<MeetingPlatform, string> = {
  google_meet: "Google Meet",
  microsoft_teams: "Teams",
  zoom: "Zoom",
  webex: "Webex",
  other: "Video call",
};

// Platforms the bot can join today.
const SUPPORTED: ReadonlySet<MeetingPlatform> = new Set(["google_meet"]);

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

const subscribeNoop = () => () => {};

export function MeetingList({ meetings }: { meetings: MeetingRow[] }) {
  // Dates are shown in the viewer's time zone, which the server doesn't know: render on the client only.
  const isClient = useSyncExternalStore(subscribeNoop, () => true, () => false);
  if (!isClient) return null;

  // Group by the viewer's local day.
  const groups = new Map<string, MeetingRow[]>();
  for (const m of meetings) {
    const day = dayFmt.format(new Date(m.startsAt));
    groups.set(day, [...(groups.get(day) ?? []), m]);
  }

  return (
    <div className="space-y-8">
      {[...groups].map(([day, items]) => (
        <section key={day} className="space-y-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">{day}</h2>
          <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
            {items.map((m) => (
              <MeetingItem key={m.id} meeting={m} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function MeetingItem({ meeting: m }: { meeting: MeetingRow }) {
  const [, startTransition] = useTransition();
  const [record, setRecordOptimistic] = useOptimistic(m.recordEnabled);
  const [error, setError] = useState<string>();
  const supported = m.platform !== null && SUPPORTED.has(m.platform);

  return (
    <li className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate font-medium">{m.title}</p>
        <p className="text-sm text-zinc-500">
          {timeFmt.format(new Date(m.startsAt))} – {timeFmt.format(new Date(m.endsAt))}
          {" · "}
          {m.platform ? (
            <a href={m.meetingUrl ?? undefined} target="_blank" rel="noreferrer" className="hover:underline">
              {PLATFORM_LABEL[m.platform]}
            </a>
          ) : (
            "No video link"
          )}
          {" · "}
          {m.calendarName}
        </p>
      </div>
      {supported ? (
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm">
          {error && <span className="text-xs text-red-600">{error}</span>}
          <input
            type="checkbox"
            checked={record}
            onChange={(e) => {
              const next = e.target.checked;
              setError(undefined);
              startTransition(async () => {
                setRecordOptimistic(next);
                try {
                  await setRecordEnabled(m.id, next);
                } catch {
                  // Most often the app was updated while this page was open.
                  setError("Couldn't save. Reload the page and try again.");
                }
              });
            }}
            className="size-4 accent-zinc-900 dark:accent-white"
          />
          Record
        </label>
      ) : (
        <span className="shrink-0 text-xs text-zinc-400">{m.platform ? "Coming soon" : ""}</span>
      )}
    </li>
  );
}
