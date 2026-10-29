import { users } from "@minuteflow/db";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { giveConsent } from "@/app/(app)/actions";
import { Icon, Logo } from "@/components/ui";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/session";

const POINTS = [
  "MinuteFlow reads your Google or Outlook calendar (read-only) to find your meetings.",
  "A notetaker joins every Google Meet call on your calendar about a minute before it starts, and records it once the host lets it in.",
  "It posts a recording notice in the meeting chat when the chat allows it, leaves when you hang up, then writes a transcript and AI notes.",
  "You can skip any meeting with its own switch, or turn automatic recording off in Settings.",
];

export default async function WelcomePage({ searchParams }: { searchParams: Promise<{ missing?: string }> }) {
  const userId = await requireUserId();
  const [user] = await db().select({ consentedAt: users.consentedAt }).from(users).where(eq(users.id, userId));
  if (user?.consentedAt) redirect("/meetings");
  const { missing } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center bg-rail px-4 py-12">
      <form action={giveConsent} className="card flex w-full max-w-[560px] flex-col gap-6 rounded-2xl p-7 md:p-9">
        <div className="flex items-center gap-2.5">
          <Logo size={32} />
          <span className="text-xl font-extrabold tracking-[-0.02em]">MinuteFlow</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-bold tracking-[-0.02em]">Before we start</h1>
          <p className="text-[15px] text-muted">Here's what MinuteFlow does with your account.</p>
        </div>
        <ul className="flex flex-col gap-3.5 text-[15px] text-ink-2">
          {POINTS.map((p) => (
            <li key={p} className="flex gap-3">
              <span className="flex size-6 flex-none items-center justify-center rounded-md bg-green-100 text-green-800">
                <Icon name="check" size={14} strokeWidth={2.4} />
              </span>
              {p}
            </li>
          ))}
        </ul>
        <label className="flex items-start gap-3 rounded-xl border border-line px-4 py-3.5 text-[15px] font-semibold">
          <input type="checkbox" name="agree" required className="mt-1 size-4 accent-green-700" />
          I agree to MinuteFlow reading my calendar and recording my Google Meet meetings automatically.
        </label>
        {missing && <p className="text-sm text-red-600">Tick the box to continue.</p>}
        <button type="submit" className="btn-cta self-start">
          Continue
        </button>
      </form>
    </main>
  );
}
