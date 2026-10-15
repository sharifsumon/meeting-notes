import { calendars, meetings, users } from "@minuteflow/db";
import { and, count, eq, gte, isNull, or } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { Logo, initials } from "@/components/ui";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/session";
import { Breadcrumb, SideNav } from "./nav";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const userId = await requireUserId();
  const session = await auth();
  const user = session?.user;

  // New users agree to calendar access and automatic recording before anything else.
  const [consent] = await db().select({ at: users.consentedAt }).from(users).where(eq(users.id, userId));
  if (!consent?.at) redirect("/welcome");

  const [upcoming] = await db()
    .select({ n: count() })
    .from(meetings)
    .leftJoin(calendars, eq(meetings.calendarId, calendars.id))
    .where(
      and(
        eq(meetings.userId, userId),
        or(isNull(meetings.calendarId), eq(calendars.enabled, true)),
        eq(meetings.cancelled, false),
        gte(meetings.endsAt, new Date()),
      ),
    );

  return (
    <div className="flex min-h-screen flex-wrap items-stretch">
      <nav
        aria-label="Main"
        className="flex flex-[1_1_232px] flex-col gap-4 border-line bg-rail px-4 py-4 md:max-w-[260px] md:gap-7 md:border-r md:py-[22px] max-md:border-b"
      >
        <Link href="/meetings" className="flex items-center gap-2.5 px-2 text-ink">
          <Logo />
          <span className="text-[19px] font-extrabold tracking-[-0.02em]">MinuteFlow</span>
        </Link>
        <SideNav upcoming={upcoming?.n ?? 0} />
      </nav>
      <div className="flex min-w-0 flex-[999_1_560px] flex-col">
        <header className="flex flex-wrap items-center gap-4 border-b border-line bg-white px-4 py-3.5 md:px-8">
          <Breadcrumb />
          <details className="relative ml-auto">
            <summary
              aria-label={`Account menu for ${user?.name ?? user?.email ?? "you"}`}
              className="flex size-11 cursor-pointer list-none items-center justify-center rounded-full bg-accent-soft text-[15px] font-bold text-accent [&::-webkit-details-marker]:hidden"
            >
              {initials(user?.name ?? user?.email)}
            </summary>
            <div className="card absolute right-0 z-20 mt-2 w-64 p-2 shadow-lg">
              <div className="px-3 py-2">
                {user?.name && <p className="truncate text-sm font-semibold">{user.name}</p>}
                <p className="truncate text-sm text-muted">{user?.email}</p>
              </div>
              <Link href="/settings" className="block rounded-lg px-3 py-2 text-sm hover:bg-page">
                Calendar settings
              </Link>
              <form
                action={async () => {
                  "use server";
                  await signOut({ redirectTo: "/" });
                }}
              >
                <button type="submit" className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-page">
                  Sign out
                </button>
              </form>
            </div>
          </details>
        </header>
        {children}
      </div>
    </div>
  );
}
