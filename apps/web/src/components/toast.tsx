"use client";

import { useEffect, useState } from "react";

const EVENT = "minuteflow:toast";

/** Shows a short message at the bottom of the screen. Survives navigation, since the Toaster lives in the layout. */
export function toast(text: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: text }));
}

export function Toaster() {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (e: Event) => {
      setText((e as CustomEvent<string>).detail);
      clearTimeout(timer);
      timer = setTimeout(() => setText(null), 3_500);
    };
    window.addEventListener(EVENT, show);
    return () => {
      window.removeEventListener(EVENT, show);
      clearTimeout(timer);
    };
  }, []);

  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-4 bottom-6 z-50 flex justify-center">
      {text && <p className="rounded-[10px] bg-ink px-4 py-3 text-sm font-semibold text-white shadow-lg">{text}</p>}
    </div>
  );
}
