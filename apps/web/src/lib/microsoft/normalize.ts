import type { NormalizedEvent } from "@/lib/google/normalize";
import { detectMeetingLink, platformForUrl } from "@/lib/meeting-links";
import type { OutlookEvent } from "./calendar";

/** Graph returns UTC times without a zone suffix when asked for UTC. */
function utc(dateTime: string) {
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(dateTime) ? dateTime : `${dateTime}Z`);
}

/** Organizer and guests (not rooms), lower-cased, for finding invited MinuteFlow users. */
export function outlookGuestEmails(event: OutlookEvent): string[] {
  const emails = [
    event.organizer?.emailAddress?.address,
    ...(event.attendees ?? []).filter((a) => a.type !== "resource").map((a) => a.emailAddress?.address),
  ];
  return [...new Set(emails.filter((e): e is string => Boolean(e)).map((e) => e.toLowerCase()))];
}

/** Converts an Outlook event to our shape. All-day events are skipped (returns null). */
export function normalizeOutlookEvent(event: OutlookEvent): NormalizedEvent | null {
  const start = event.start?.dateTime;
  const end = event.end?.dateTime;
  if (event.isAllDay || !start || !end) return null;

  const joinUrl = event.onlineMeeting?.joinUrl;
  const detected = joinUrl
    ? { url: joinUrl, platform: platformForUrl(joinUrl) }
    : detectMeetingLink(event.location?.displayName, event.body?.content);

  return {
    externalEventId: event.id,
    title: event.subject?.trim() || "(No title)",
    startsAt: utc(start),
    endsAt: utc(end),
    meetingUrl: detected?.url ?? null,
    platform: detected?.platform ?? null,
    cancelled: event.isCancelled ?? false,
  };
}
