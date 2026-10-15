"use client";

import { useSyncExternalStore } from "react";

const subscribeNoop = () => () => {};

const FORMATS = {
  day: { weekday: "short", day: "numeric", month: "short", year: "numeric" },
  time: { hour: "numeric", minute: "2-digit" },
  dateTime: { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

/** A date in the viewer's own time zone. Renders nothing on the server, which doesn't know it. */
export function LocalTime({ iso, format }: { iso: string; format: keyof typeof FORMATS }) {
  const isClient = useSyncExternalStore(subscribeNoop, () => true, () => false);
  if (!isClient) return null;
  return <time dateTime={iso}>{new Intl.DateTimeFormat(undefined, FORMATS[format]).format(new Date(iso))}</time>;
}
