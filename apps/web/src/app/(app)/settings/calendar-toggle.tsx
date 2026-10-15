"use client";

import { useOptimistic, useState, useTransition } from "react";
import { setAutoRecord, setCalendarEnabled } from "../actions";

export function CalendarToggle({ calendarId, enabled }: { calendarId: string; enabled: boolean }) {
  return <Toggle label="Watch" enabled={enabled} save={(next) => setCalendarEnabled(calendarId, next)} />;
}

export function AutoRecordToggle({ enabled }: { enabled: boolean }) {
  return <Toggle label="Record all my meetings automatically" enabled={enabled} save={setAutoRecord} />;
}

function Toggle({
  label,
  enabled,
  save,
}: {
  label: string;
  enabled: boolean;
  save: (next: boolean) => Promise<{ error?: string }>;
}) {
  const [pending, startTransition] = useTransition();
  const [checked, setChecked] = useOptimistic(enabled);
  const [error, setError] = useState<string>();

  return (
    <label className="flex shrink-0 cursor-pointer items-center gap-3 text-sm font-semibold text-ink-2">
      {error && <span className="font-normal text-red-600">{error}</span>}
      {label}
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.checked;
          startTransition(async () => {
            setChecked(next);
            setError((await save(next)).error);
          });
        }}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className="relative h-6 w-10 rounded-full bg-slate-300 transition-colors peer-checked:bg-green-600 peer-disabled:opacity-60 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent after:absolute after:top-0.5 after:left-0.5 after:size-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-4"
      />
    </label>
  );
}
