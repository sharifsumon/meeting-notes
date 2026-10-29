import "server-only";
import { graphGet } from "./client";

const API = "https://graph.microsoft.com/v1.0";

export type OutlookCalendar = { id: string; name: string; isDefaultCalendar?: boolean };

type EmailAddress = { emailAddress?: { address?: string } };

export type OutlookEvent = {
  id: string;
  subject?: string;
  isCancelled?: boolean;
  isAllDay?: boolean;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  location?: { displayName?: string };
  body?: { content?: string };
  onlineMeeting?: { joinUrl?: string } | null;
  organizer?: EmailAddress;
  attendees?: Array<EmailAddress & { type?: string }>;
};

type Page<T> = { value?: T[]; "@odata.nextLink"?: string };

async function listAll<T>(userId: string, url: string): Promise<T[]> {
  const items: T[] = [];
  let next: string | undefined = url;
  while (next) {
    const page: Page<T> = await graphGet<Page<T>>(userId, next);
    items.push(...(page.value ?? []));
    next = page["@odata.nextLink"];
  }
  return items;
}

export function listOutlookCalendars(userId: string) {
  return listAll<OutlookCalendar>(userId, `${API}/me/calendars?$select=id,name,isDefaultCalendar&$top=100`);
}

export function listOutlookEvents(userId: string, calendarId: string, timeMin: Date, timeMax: Date) {
  const params = new URLSearchParams({
    startDateTime: timeMin.toISOString(),
    endDateTime: timeMax.toISOString(),
    $select: "id,subject,isCancelled,isAllDay,start,end,location,body,onlineMeeting,organizer,attendees",
    $top: "250",
  });
  return listAll<OutlookEvent>(userId, `${API}/me/calendars/${encodeURIComponent(calendarId)}/calendarView?${params}`);
}
