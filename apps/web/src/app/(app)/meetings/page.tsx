import { calendars } from "@minuteflow/db";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { GoogleReconnectRequired } from "@/lib/google/client";
import { recordedMeetings, upcomingMeetings } from "@/lib/meetings";
import { requireUserId } from "@/lib/session";
import { syncAll } from "@/lib/sync";
import { MeetingList, TodayLine } from "./meeting-list";
import { SendBotForm } from "./send-bot-form";
import { SyncButton } from "./sync-button";

const TABS = [
  { id: "upcoming", label: "Upcoming" },
  { id: "recorded", label: "Recorded" },
] as const;

export default async function MeetingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const userId = await requireUserId();
  const tab = (await searchParams).tab === "recorded" ? "recorded" : "upcoming";

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

  const data = tab === "recorded" ? await recordedMeetings(userId) : await upcomingMeetings(userId);

  return (
    <main className="flex w-full max-w-[1120px] flex-col gap-6 px-4 pt-7 pb-12 md:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-extrabold tracking-[-0.02em]">Meetings</h1>
          <TodayLine meetings={tab === "upcoming" ? data : []} />
        </div>
        <SyncButton />
      </div>

      <div role="tablist" aria-label="Meeting views" className="flex flex-wrap gap-2">
        {TABS.map((t) => {
          const on = t.id === tab;
          return (
            <Link
              key={t.id}
              href={t.id === "upcoming" ? "/meetings" : `/meetings?tab=${t.id}`}
              role="tab"
              aria-selected={on}
              className={`flex min-h-10 items-center rounded-full border px-4 text-sm ${
                on ? "border-sky-200 bg-accent-soft font-semibold text-accent" : "border-line bg-white font-medium text-ink-2 hover:bg-page"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>

      {tab === "upcoming" && <SendBotForm />}

      {data.length === 0 ? (
        <p className="text-muted">
          {tab === "upcoming" ? (
            <>
              Currently you have no scheduled meeting. Check which calendars are turned on in{" "}
              <Link href="/settings" className="font-semibold text-accent hover:underline">
                Settings
              </Link>
              .
            </>
          ) : (
            "Nothing recorded yet. Turn on Record for a Google Meet call, or send the bot to one from the Upcoming tab."
          )}
        </p>
      ) : (
        <MeetingList meetings={data} />
      )}
    </main>
  );
}
