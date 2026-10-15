"use client";

import { useState, useTransition } from "react";
import { Icon } from "@/components/ui";
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
        className="btn-outline"
      >
        <Icon name="refresh" size={16} className={pending ? "animate-spin" : undefined} />
        {pending ? "Syncing…" : "Sync calendar"}
      </button>
    </div>
  );
}
