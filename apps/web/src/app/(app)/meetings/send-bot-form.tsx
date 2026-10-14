"use client";

import { useState, useTransition } from "react";
import { Icon } from "@/components/ui";
import { sendBotNow } from "../actions";

export function SendBotForm() {
  const [pending, startTransition] = useTransition();
  const [link, setLink] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();

  return (
    <form
      className="card flex flex-col gap-3 p-5"
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
      <label htmlFor="meet-link" className="text-[15px] font-bold">
        Send the notetaker to a call now
      </label>
      <div className="flex flex-wrap gap-2">
        <div className="field flex-[1_1_280px]">
          <Icon name="video" size={18} className="text-muted" />
          <input
            id="meet-link"
            type="url"
            required
            placeholder="https://meet.google.com/abc-defg-hij"
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
        </div>
        <button type="submit" disabled={pending} className="btn-cta">
          {pending ? "Sending…" : "Send bot"}
        </button>
      </div>
      {message && <p className={`text-sm ${message.ok ? "text-green-700" : "text-red-600"}`}>{message.text}</p>}
    </form>
  );
}
