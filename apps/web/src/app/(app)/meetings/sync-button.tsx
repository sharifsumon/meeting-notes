"use client";

import { useState, useTransition } from "react";
import { syncNow } from "../actions";

export function SyncButton() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();

  return (
    <div className="flex items-center gap-3">
      {error && <span className="text-sm text-red-600">{error}</span>}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError((await syncNow()).error);
          })
        }
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        {pending ? "Syncing…" : "Sync now"}
      </button>
    </div>
  );
}
