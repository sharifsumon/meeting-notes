import { calendars, meetings } from "@minuteflow/db";
import { and, asc, eq, gte } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { GoogleReconnectRequired } from "@/lib/google/client";
import { requireUserId } from "@/lib/session";
import { syncAll } from "@/lib/sync";
import { MeetingList, type MeetingRow } from "./meeting-list";
import { SyncButton } from "./sync-button";

export default async function MeetingsPage() {
  const userId = await requireUserId();

  // First visit after sign-in: pull calendars and meetings so the page isn't empty.
  const [anyCalendar] = await db().select({ id: calendars.id }).from(calendars).where(eq(calendars.userId, userId)).limit(1);
  if (!anyCalendar) {
    try {
      await syncAll(userId);
    } catch (err) {
      if (err instanceof GoogleReconnectRequired) redirect("/settings?reconnect=1");
      console.error("Initial calendar sync failed", err);
    }
  }

  const rows = await db()
    .select({
      id: meetings.id,
      title: meetings.title,
      startsAt: meetings.startsAt,
      endsAt: meetings.endsAt,
      meetingUrl: meetings.meetingUrl,
      platform: meetings.platform,
      recordEnabled: meetings.recordEnabled,
      calendarName: calendars.name,
    })
    .from(meetings)
    .innerJoin(calendars, eq(meetings.calendarId, calendars.id))
    .where(
      and(
        eq(meetings.userId, userId),
        eq(calendars.enabled, true),
        eq(meetings.cancelled, false),
        gte(meetings.endsAt, new Date()),
      ),
    )
    .orderBy(asc(meetings.startsAt))
    .limit(200);

  const data: MeetingRow[] = rows.map((r) => ({
    ...r,
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
  }));

  return (
    <main className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Upcoming meetings</h1>
        <SyncButton />
      </div>
      {data.length === 0 ? (
        <p className="text-zinc-500">
          No upcoming meetings in the next two weeks. Check which calendars are turned on in{" "}
          <Link href="/settings" className="underline underline-offset-4">
            Calendars
          </Link>
          .
        </p>
      ) : (
        <MeetingList meetings={data} />
      )}
    </main>
  );
}
