"use client";

import { useOptimistic, useState, useTransition } from "react";
import { setCalendarEnabled } from "../actions";

export function CalendarToggle({ calendarId, enabled }: { calendarId: string; enabled: boolean }) {
  const [pending, startTransition] = useTransition();
  const [checked, setChecked] = useOptimistic(enabled);
  const [error, setError] = useState<string>();

  return (
    <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm">
      {error && <span className="text-red-600">{error}</span>}
      <input
        type="checkbox"
        checked={checked}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.checked;
          startTransition(async () => {
            setChecked(next);
            setError((await setCalendarEnabled(calendarId, next)).error);
          });
        }}
        className="size-4 accent-zinc-900 dark:accent-white"
      />
      Watch
    </label>
  );
}
