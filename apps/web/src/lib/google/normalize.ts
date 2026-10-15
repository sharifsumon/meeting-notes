import { detectMeetingLink, platformForUrl, type MeetingPlatform } from "@/lib/meeting-links";
import type { GoogleEvent } from "./calendar";

export type NormalizedEvent = {
  externalEventId: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  meetingUrl: string | null;
  platform: MeetingPlatform | null;
  cancelled: boolean;
};

/** Converts a Google event to our shape. All-day events are skipped (returns null). */
export function normalizeGoogleEvent(event: GoogleEvent): NormalizedEvent | null {
  const start = event.start?.dateTime;
  const end = event.end?.dateTime;
  if (!start || !end) return null;

  const videoEntry = event.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri;
  const directUrl = event.hangoutLink ?? videoEntry;
  const detected = directUrl
    ? { url: directUrl, platform: platformForUrl(directUrl) }
    : detectMeetingLink(event.location, event.description);

  return {
    externalEventId: event.id,
    title: event.summary?.trim() || "(No title)",
    startsAt: new Date(start),
    endsAt: new Date(end),
    meetingUrl: detected?.url ?? null,
    platform: detected?.platform ?? null,
    cancelled: event.status === "cancelled",
  };
}
