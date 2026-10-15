import "server-only";
import { googleGet } from "./client";

const API = "https://www.googleapis.com/calendar/v3";

export type GoogleCalendar = {
  id: string;
  summary: string;
  summaryOverride?: string;
  primary?: boolean;
  timeZone?: string;
  accessRole: string;
};

export type GoogleEvent = {
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  hangoutLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  conferenceData?: {
    entryPoints?: Array<{ entryPointType: string; uri: string }>;
  };
};

type Page<T> = { items?: T[]; nextPageToken?: string };

async function listAll<T>(userId: string, url: string, params: Record<string, string>): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined;
  do {
    const page = await googleGet<Page<T>>(userId, url, pageToken ? { ...params, pageToken } : params);
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

export function listCalendars(userId: string) {
  return listAll<GoogleCalendar>(userId, `${API}/users/me/calendarList`, { maxResults: "250" });
}

export function listEvents(userId: string, calendarId: string, timeMin: Date, timeMax: Date) {
  return listAll<GoogleEvent>(userId, `${API}/calendars/${encodeURIComponent(calendarId)}/events`, {
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });
}
