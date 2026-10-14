"use client";

import { useOptimistic, useState, useTransition } from "react";
import { setCalendarEnabled } from "../actions";

export function CalendarToggle({ calendarId, enabled }: { calendarId: string; enabled: boolean }) {
  const [pending, startTransition] = useTransition();
  const [checked, setChecked] = useOptimistic(enabled);
  const [error, setError] = useState<string>();

  return (
    <label className="flex shrink-0 cursor-pointer items-center gap-3 text-sm font-semibold text-ink-2">
      {error && <span className="font-normal text-red-600">{error}</span>}
      Watch
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.checked;
          startTransition(async () => {
            setChecked(next);
            setError((await setCalendarEnabled(calendarId, next)).error);
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
