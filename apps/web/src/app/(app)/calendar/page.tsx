import { meetingsBetween } from "@/lib/meetings";
import { requireUserId } from "@/lib/session";
import { WeekView } from "./week-view";

const DAY_MS = 24 * 60 * 60 * 1000;

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  const userId = await requireUserId();
  const raw = Number.parseInt((await searchParams).w ?? "0", 10);
  const week = Number.isFinite(raw) ? Math.max(-52, Math.min(52, raw)) : 0;

  // The viewer's week boundaries depend on their time zone, so fetch a wide window and let the browser pick.
  const centre = Date.now() + week * 7 * DAY_MS;
  const data = await meetingsBetween(userId, new Date(centre - 8 * DAY_MS), new Date(centre + 8 * DAY_MS));

  return (
    <main className="flex w-full flex-col gap-5 px-4 pt-6 pb-10 md:px-8">
      <WeekView week={week} meetings={data} />
    </main>
  );
}
