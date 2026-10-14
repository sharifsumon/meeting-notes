import { calendars } from "@minuteflow/db";
import { asc, desc, eq } from "drizzle-orm";
import { signIn } from "@/auth";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/session";
import { CalendarToggle } from "./calendar-toggle";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ reconnect?: string }> }) {
  const userId = await requireUserId();
  const { reconnect } = await searchParams;

  const rows = await db()
    .select()
    .from(calendars)
    .where(eq(calendars.userId, userId))
    .orderBy(desc(calendars.isPrimary), asc(calendars.name));

  return (
    <main className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Calendars</h1>
        <p className="text-zinc-500">Choose which calendars MinuteFlow watches for meetings.</p>
      </div>

      {reconnect && (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <span>We lost access to your Google Calendar. Reconnect and make sure calendar access is ticked.</span>
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/meetings" });
            }}
          >
            <button type="submit" className="shrink-0 font-medium underline underline-offset-4">
              Reconnect Google
            </button>
          </form>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-zinc-500">No calendars yet. Open Meetings and press Sync now.</p>
      ) : (
        <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
          {rows.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {c.name}
                  {c.isPrimary && <span className="ml-2 text-xs font-normal text-zinc-500">Primary</span>}
                </p>
                <p className="text-sm text-zinc-500">
                  Google Calendar
                  {c.lastSyncedAt && ` · synced ${c.lastSyncedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`}
                </p>
              </div>
              <CalendarToggle calendarId={c.id} enabled={c.enabled} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
