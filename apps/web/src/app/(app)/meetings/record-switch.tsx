"use client";

import { useOptimistic, useState, useTransition } from "react";
import { setRecordEnabled } from "../actions";

/** "Send notetaker" switch for one meeting. Saves straight away. */
export function RecordSwitch({ meetingId, enabled, label = "Record" }: { meetingId: string; enabled: boolean; label?: string }) {
  const [, startTransition] = useTransition();
  const [on, setOn] = useOptimistic(enabled);
  const [error, setError] = useState<string>();

  return (
    <div className="flex flex-col items-end gap-1">
      <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[10px] border border-line bg-white px-3 text-sm font-semibold text-ink-2">
        {label}
        <input
          type="checkbox"
          role="switch"
          checked={on}
          onChange={(e) => {
            const next = e.target.checked;
            setError(undefined);
            startTransition(async () => {
              setOn(next);
              try {
                await setRecordEnabled(meetingId, next);
              } catch {
                // Most often the app was updated while this page was open.
                setError("Couldn't save. Reload the page and try again.");
              }
            });
          }}
          className="peer sr-only"
        />
        <span
          aria-hidden="true"
          className="relative h-6 w-10 rounded-full bg-slate-300 transition-colors peer-checked:bg-green-600 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent after:absolute after:top-0.5 after:left-0.5 after:size-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-4"
        />
      </label>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
