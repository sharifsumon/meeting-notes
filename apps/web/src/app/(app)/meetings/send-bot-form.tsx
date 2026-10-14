"use client";

import { useState, useTransition } from "react";
import { sendBotNow } from "../actions";

export function SendBotForm() {
  const [pending, startTransition] = useTransition();
  const [link, setLink] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();

  return (
    <form
      className="space-y-2 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const { error } = await sendBotNow(link).catch(() => ({
            error: "Couldn't send the bot. Reload the page and try again.",
          }));
          setMessage(error ? { ok: false, text: error } : { ok: true, text: "The bot will ask to join within a minute. Admit it from the call." });
          if (!error) setLink("");
        });
      }}
    >
      <label htmlFor="meet-link" className="text-sm font-medium">
        Send the notetaker to a call now
      </label>
      <div className="flex gap-2">
        <input
          id="meet-link"
          type="url"
          required
          placeholder="https://meet.google.com/abc-defg-hij"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-transparent px-3 py-1.5 text-sm dark:border-zinc-700"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900"
        >
          {pending ? "Sending…" : "Send bot"}
        </button>
      </div>
      {message && <p className={`text-sm ${message.ok ? "text-green-700 dark:text-green-400" : "text-red-600"}`}>{message.text}</p>}
    </form>
  );
}
