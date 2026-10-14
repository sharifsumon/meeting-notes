"use server";

import { calendars, meetings } from "@minuteflow/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { detectMeetingLink } from "@/lib/meeting-links";
import { GoogleReconnectRequired } from "@/lib/google/client";
import { requireUserId } from "@/lib/session";
import { syncAll, syncMeetings } from "@/lib/sync";

export type ActionResult = { error?: string };

async function runSync(fn: () => Promise<void>): Promise<ActionResult> {
  try {
    await fn();
    return {};
  } catch (err) {
    if (err instanceof GoogleReconnectRequired) redirect("/settings?reconnect=1");
    console.error("Calendar sync failed", err);
    return { error: "Couldn't reach Google Calendar. Try again in a moment." };
  }
}

export async function syncNow(): Promise<ActionResult> {
  const userId = await requireUserId();
  const result = await runSync(() => syncAll(userId));
  revalidatePath("/meetings");
  revalidatePath("/settings");
  return result;
}

export async function setRecordEnabled(meetingId: string, enabled: boolean) {
  const userId = await requireUserId();
  await db()
    .update(meetings)
    .set({ recordEnabled: enabled })
    .where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId)));
  revalidatePath("/meetings");
}

export async function setCalendarEnabled(calendarId: string, enabled: boolean): Promise<ActionResult> {
  const userId = await requireUserId();
  await db()
    .update(calendars)
    .set({ enabled })
    .where(and(eq(calendars.id, calendarId), eq(calendars.userId, userId)));
  const result = enabled ? await runSync(() => syncMeetings(userId)) : {};
  revalidatePath("/meetings");
  revalidatePath("/settings");
  return result;
}

const AD_HOC_DURATION_MS = 2 * 60 * 60 * 1000;

/** Sends the bot to a meeting right now from a pasted link, without a calendar event. */
export async function sendBotNow(link: string): Promise<ActionResult> {
  const userId = await requireUserId();
  const detected = detectMeetingLink(link.trim());
  if (!detected) return { error: "That doesn't look like a meeting link." };
  if (detected.platform !== "google_meet") return { error: "Only Google Meet links are supported for now." };

  const now = new Date();
  await db()
    .insert(meetings)
    .values({
      userId,
      title: "Meeting from link",
      startsAt: now,
      endsAt: new Date(now.getTime() + AD_HOC_DURATION_MS),
      meetingUrl: detected.url,
      platform: detected.platform,
      recordEnabled: true,
    });
  revalidatePath("/meetings");
  return {};
}
