import { meetingsBetween } from "@/lib/meetings";
import { requireUserId } from "@/lib/session";
import { DayList } from "./day-list";

const DAY_MS = 24 * 60 * 60 * 1000;

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ d?: string }> }) {
  const userId = await requireUserId();
  const raw = Number.parseInt((await searchParams).d ?? "0", 10);
  const offset = Number.isFinite(raw) ? Math.max(-366, Math.min(366, raw)) : 0;

  // The viewer's day boundaries depend on their time zone, so fetch a wider window and let the browser pick.
  const centre = Date.now() + offset * DAY_MS;
  const data = await meetingsBetween(userId, new Date(centre - 2 * DAY_MS), new Date(centre + 2 * DAY_MS));

  return (
    <main className="flex w-full max-w-[1120px] flex-col gap-5 px-4 pt-6 pb-10 md:px-8">
      <DayList offset={offset} meetings={data} />
    </main>
  );
}
