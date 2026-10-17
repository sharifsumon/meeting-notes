"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "@/components/toast";
import { Icon } from "@/components/ui";
import { deleteMeeting } from "../actions";

/** "Delete" with a confirmation dialog. Removes the meeting with its recording, transcript and notes. */
export function DeleteMeetingButton({ meetingId, title, redirectTo }: { meetingId: string; title: string; redirectTo?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();

  return (
    <>
      <button
        type="button"
        className="btn-outline text-red-700"
        onClick={() => {
          setError(undefined);
          dialog.current?.showModal();
        }}
      >
        <Icon name="trash" size={17} />
        Delete
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={`delete-${meetingId}`}
        className="card m-auto w-[min(420px,calc(100vw-32px))] p-6 backdrop:bg-ink/40"
      >
        <h2 id={`delete-${meetingId}`} className="text-lg font-bold">
          Do you really want to delete?
        </h2>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-2">
          “{title}” will be removed with its recording, transcript and notes. This can't be undone. The event stays in your
          calendar.
        </p>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-outline" onClick={() => dialog.current?.close()} disabled={pending}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-danger"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const { error } = await deleteMeeting(meetingId).catch(() => ({
                  error: "Couldn't delete the meeting. Reload the page and try again.",
                }));
                if (error) return setError(error);
                dialog.current?.close();
                toast("Meeting deleted");
                if (redirectTo) router.push(redirectTo);
                else router.refresh();
              })
            }
          >
            {pending ? "Deleting…" : "Delete"}
          </button>
        </div>
      </dialog>
    </>
  );
}
