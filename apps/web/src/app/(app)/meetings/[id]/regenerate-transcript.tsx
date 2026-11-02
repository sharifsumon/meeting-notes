"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Icon } from "@/components/ui";
import { regenerateTranscript } from "../../actions";

/** "Regenerate" beside the transcript search: transcribes the recording again in the background. */
export function RegenerateTranscriptButton({ meetingId, running }: { meetingId: string; running: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();
  const busy = running || pending;

  // The bot works in the background; check back until the new transcript and notes are in.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => router.refresh(), 10_000);
    return () => clearInterval(timer);
  }, [running, router]);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        className="btn-outline min-h-10"
        disabled={busy}
        onClick={() =>
          startTransition(async () => {
            setError(undefined);
            const { error } = await regenerateTranscript(meetingId).catch(() => ({
              error: "Couldn't start. Reload the page and try again.",
            }));
            if (error) setError(error);
            router.refresh();
          })
        }
      >
        <Icon name="refresh" size={16} className={busy ? "animate-spin" : undefined} />
        {busy ? "Regenerating…" : "Regenerate"}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
