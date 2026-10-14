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
    <main className="flex w-full max-w-[1120px] flex-col gap-6 px-4 pt-7 pb-12 md:px-8">
      <div>
        <h1 className="text-[28px] font-extrabold tracking-[-0.02em]">Settings</h1>
        <p className="mt-1.5 text-[15px] text-muted">Choose which calendars MinuteFlow watches for meetings.</p>
      </div>

      {reconnect && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
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
        <p className="text-muted">No calendars yet. Open Meetings and press Sync calendar.</p>
      ) : (
        <section className="flex flex-col gap-3">
          <h2 className="section-label">Google Calendar</h2>
          <ul className="card divide-y divide-line-soft">
          {rows.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <p className="truncate text-[15px] font-bold">
                  {c.name}
                  {c.isPrimary && <span className="pill ml-2 bg-accent-soft text-xs text-accent">Primary</span>}
                </p>
                <p className="mt-0.5 text-sm text-muted">
                  Google Calendar
                  {c.lastSyncedAt && ` · synced ${c.lastSyncedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`}
                </p>
              </div>
              <CalendarToggle calendarId={c.id} enabled={c.enabled} />
            </li>
          ))}
          </ul>
        </section>
      )}
    </main>
  );
}
