import { accounts, calendars, users } from "@minuteflow/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { signIn } from "@/auth";
import { decrypt } from "@/lib/crypto";
import { hasCalendarScope } from "@/lib/google/client";
import { db } from "@/lib/db";
import { env, microsoftEnabled } from "@/env";
import { MicrosoftMark } from "@/components/ui";
import { MICROSOFT_PROVIDER } from "@/lib/microsoft/client";
import { requireUserId } from "@/lib/session";
import { AutoRecordToggle, CalendarToggle } from "./calendar-toggle";
import { GeminiKeyForm } from "./gemini-key";

const LINK_ERRORS: Record<string, string> = {
  OAuthAccountNotLinked: "That account is already used by another MinuteFlow login, so it can't be connected here.",
};

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ reconnect?: string; error?: string }> }) {
  const userId = await requireUserId();
  const { reconnect, error } = await searchParams;

  const rows = await db()
    .select()
    .from(calendars)
    .where(eq(calendars.userId, userId))
    .orderBy(desc(calendars.isPrimary), asc(calendars.name));
  const [user] = await db()
    .select({ autoRecord: users.autoRecord, geminiApiKey: users.geminiApiKey })
    .from(users)
    .where(eq(users.id, userId));
  const [google] = await db()
    .select({ scope: accounts.scope })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, "google")))
    .limit(1);
  const calendarNotGranted = Boolean(google) && !hasCalendarScope(google!.scope);
  const [microsoft] = await db()
    .select({ provider: accounts.provider })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, MICROSOFT_PROVIDER)))
    .limit(1);
  const withMicrosoft = microsoftEnabled();
  // Only the last four characters ever reach the browser.
  let savedKeyEnd: string | null = null;
  try {
    savedKeyEnd = user?.geminiApiKey ? decrypt(user.geminiApiKey, env().TOKEN_ENCRYPTION_KEY).slice(-4) : null;
  } catch {
    savedKeyEnd = "????";
  }

  return (
    <main className="flex w-full max-w-[1120px] flex-col gap-6 px-4 pt-7 pb-12 md:px-8">
      <div>
        <h1 className="text-[28px] font-extrabold tracking-[-0.02em]">Settings</h1>
        <p className="mt-1.5 text-[15px] text-muted">Choose which calendars MinuteFlow watches, whether the notetaker records your calls on its own, and which Gemini key it uses.</p>
      </div>

      {error && (
        <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {LINK_ERRORS[error] ?? "Connecting that account didn't finish. Please try again."}
        </p>
      )}

      {reconnect === "microsoft" && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span>We lost access to your Outlook calendar. Reconnect Microsoft to keep it in sync.</span>
          <form
            action={async () => {
              "use server";
              await signIn(MICROSOFT_PROVIDER, { redirectTo: "/settings" });
            }}
          >
            <button type="submit" className="shrink-0 font-medium underline underline-offset-4">
              Reconnect Microsoft
            </button>
          </form>
        </div>
      )}

      {((reconnect && reconnect !== "microsoft") || calendarNotGranted) && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span>
            {calendarNotGranted
              ? "MinuteFlow can't see your Google Calendar yet. Press Reconnect Google and tick both calendar boxes on Google's screen."
              : "We lost access to your Google Calendar. Reconnect and make sure both calendar boxes are ticked."}
          </span>
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

      <section className="flex flex-col gap-3">
        <h2 className="section-label">Accounts</h2>
        <ul className="card divide-y divide-line-soft">
          <AccountRow
            name="Google"
            mark={<span className="text-[15px] font-extrabold text-blue-600">G</span>}
            connected={Boolean(google)}
            connect={async () => {
              "use server";
              await signIn("google", { redirectTo: "/settings" });
            }}
          />
          {(withMicrosoft || microsoft) && (
            <AccountRow
              name="Microsoft (Outlook / Teams)"
              mark={<MicrosoftMark size={16} />}
              connected={Boolean(microsoft)}
              connect={async () => {
                "use server";
                await signIn(MICROSOFT_PROVIDER, { redirectTo: "/settings" });
              }}
            />
          )}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="section-label">Recording</h2>
        <div className="card flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <p className="min-w-0 flex-[1_1_320px] text-sm text-muted">
            The notetaker joins every Google Meet call on your watched calendars about a minute before it starts.
            You can still skip a single meeting with its own switch.
          </p>
          <AutoRecordToggle enabled={user?.autoRecord ?? true} />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="section-label">Gemini API key</h2>
        <div className="card flex flex-wrap items-start justify-between gap-4 px-5 py-4">
          <p className="min-w-0 flex-[1_1_280px] text-sm text-muted">
            MinuteFlow uses Gemini to transcribe and write notes. To use your own Google AI Studio quota and billing for
            your calls, paste your key here. It&apos;s stored encrypted and never shown again.
          </p>
          <GeminiKeyForm saved={savedKeyEnd} />
          <div className="w-full rounded-xl border border-line bg-slate-50 px-4 py-3 text-sm text-ink-2">
            <p className="font-semibold">Tips</p>
            <ol className="mt-1.5 list-decimal space-y-1 pl-5">
              <li>
                Open{" "}
                <a
                  href="https://aistudio.google.com/app/apikey"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-accent underline underline-offset-4"
                >
                  Google AI Studio → API keys
                </a>{" "}
                and sign in with your Google account.
              </li>
              <li>Press &quot;Create API key&quot;, pick or create a project, then copy the key (it starts with AIza).</li>
              <li>Paste it above and press Save key. MinuteFlow checks it with Google before saving.</li>
              <li>
                Free keys have a daily limit that busy days can use up. Turn on billing for the key&apos;s project in AI
                Studio to avoid gaps; it costs a few cents per hour of meetings.
              </li>
              <li>Never share your key with anyone. You can delete it in AI Studio at any time and create a new one.</li>
            </ol>
          </div>
        </div>
      </section>

      {rows.length === 0 ? (
        <p className="text-muted">No calendars yet. Open Meetings and press Sync calendar.</p>
      ) : (
        <section className="flex flex-col gap-3">
          <h2 className="section-label">Calendars</h2>
          <ul className="card divide-y divide-line-soft">
          {rows.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <p className="truncate text-[15px] font-bold">
                  {c.name}
                  {c.isPrimary && <span className="pill ml-2 bg-accent-soft text-xs text-accent">Primary</span>}
                </p>
                <p className="mt-0.5 text-sm text-muted">
                  {c.provider === "microsoft" ? "Outlook calendar" : "Google Calendar"}
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

function AccountRow({ name, mark, connected, connect }: { name: string; mark: React.ReactNode; connected: boolean; connect: () => Promise<void> }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
      <span className="flex items-center gap-3 text-[15px] font-bold">
        <span className="flex size-8 items-center justify-center rounded-full border border-line">{mark}</span>
        {name}
      </span>
      {connected ? (
        <span className="pill bg-green-50 font-medium text-green-800">Connected</span>
      ) : (
        <form action={connect}>
          <button type="submit" className="btn-outline">
            Connect
          </button>
        </form>
      )}
    </li>
  );
}
