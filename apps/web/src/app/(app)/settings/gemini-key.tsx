"use client";

import { useState, useTransition } from "react";
import { removeGeminiKey, saveGeminiKey } from "../actions";

/** `saved` is the last four characters of the user's own key, or null when they use MinuteFlow's. */
export function GeminiKeyForm({ saved }: { saved: string | null }) {
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();

  const run = (action: () => Promise<{ error?: string }>) =>
    startTransition(async () => {
      const result = await action();
      setError(result.error);
      if (!result.error) setValue("");
    });

  return (
    <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-3">
      <p className="text-sm text-ink-2">
        {saved ? (
          <>
            Using <span className="font-semibold">your own key</span> ending in{" "}
            <span className="font-mono">••••{saved}</span>.
          </>
        ) : (
          <>
            Using <span className="font-semibold">MinuteFlow&apos;s key</span>.
          </>
        )}
      </p>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => saveGeminiKey(value));
        }}
      >
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label="Gemini API key"
          placeholder={saved ? "Paste a new key to replace it" : "Paste your Gemini API key"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="min-h-10 min-w-0 flex-[1_1_240px] rounded-lg border border-line bg-white px-3 font-mono text-sm"
        />
        <button
          type="submit"
          disabled={pending || !value.trim()}
          className="min-h-10 rounded-lg bg-accent px-4 text-sm font-semibold text-white disabled:opacity-60"
        >
          {pending ? "Checking…" : "Save key"}
        </button>
        {saved && (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(removeGeminiKey)}
            className="min-h-10 rounded-lg px-3 text-sm font-semibold text-ink-3 hover:text-ink disabled:opacity-60"
          >
            Use MinuteFlow&apos;s key
          </button>
        )}
      </form>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
