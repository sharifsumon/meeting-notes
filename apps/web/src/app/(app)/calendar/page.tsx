import { meetingsBetween } from "@/lib/meetings";
import { requireUserId } from "@/lib/session";
import { WeekView } from "./week-view";

const DAY_MS = 24 * 60 * 60 * 1000;

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ w?: string; d?: string; view?: string }> }) {
  const userId = await requireUserId();
  const params = await searchParams;
  const view = params.view === "day" ? "day" : "week";
  const raw = Number.parseInt((view === "day" ? params.d : params.w) ?? "0", 10);
  const limit = view === "day" ? 366 : 52;
  const offset = Number.isFinite(raw) ? Math.max(-limit, Math.min(limit, raw)) : 0;

  // The viewer's day and week boundaries depend on their time zone, so fetch a wide window and let the browser pick.
  const centre = Date.now() + offset * (view === "day" ? 1 : 7) * DAY_MS;
  const data = await meetingsBetween(userId, new Date(centre - 8 * DAY_MS), new Date(centre + 8 * DAY_MS));

  return (
    <main className="flex w-full flex-col gap-5 px-4 pt-6 pb-10 md:px-8">
      <WeekView view={view} offset={offset} meetings={data} />
    </main>
  );
}
