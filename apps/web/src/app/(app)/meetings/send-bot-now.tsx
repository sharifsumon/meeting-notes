"use client";

import { useState, useTransition } from "react";
import { Icon } from "@/components/ui";
import { sendBotToMeeting } from "../actions";

/** Sends the bot to this meeting right away instead of at its start time. */
export function SendBotNowButton({ meetingId }: { meetingId: string }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();

  if (message?.ok) return <span className="text-sm text-green-700">{message.text}</span>;

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        className="btn-outline"
        onClick={() =>
          startTransition(async () => {
            const { error } = await sendBotToMeeting(meetingId).catch(() => ({
              error: "Couldn't send the bot. Reload the page and try again.",
            }));
            setMessage(error ? { ok: false, text: error } : { ok: true, text: "The bot will ask to join within a minute." });
          })
        }
      >
        <Icon name="video" size={17} />
        {pending ? "Sending…" : "Send bot now"}
      </button>
      {message && <span className="text-xs text-red-600">{message.text}</span>}
    </div>
  );
}

/**
 * "Join meeting" that also sends the bot right away, so it's in the call when you are.
 * The link opens straight from the click so the browser doesn't block the new tab.
 */
export function JoinMeetingLink({ meetingId, url, sendBot }: { meetingId: string; url: string; sendBot: boolean }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="btn-cta"
      onClick={() => {
        if (sendBot) sendBotToMeeting(meetingId).catch((err) => console.error("Couldn't send the bot", err));
      }}
    >
      <Icon name="video" size={18} strokeWidth={2.2} />
      Join meeting
    </a>
  );
}
