import Link from "next/link";
import { auth, signOut } from "@/auth";
import { requireUserId } from "@/lib/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireUserId();
  const session = await auth();

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <header className="mb-8 flex items-center justify-between gap-4">
        <nav className="flex items-center gap-5">
          <Link href="/meetings" className="text-lg font-semibold">
            MinuteFlow
          </Link>
          <Link href="/meetings" className="text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white">
            Meetings
          </Link>
          <Link href="/settings" className="text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white">
            Calendars
          </Link>
        </nav>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/" });
          }}
          className="flex items-center gap-3"
        >
          <span className="hidden text-sm text-zinc-500 sm:inline">{session?.user?.email}</span>
          <button type="submit" className="text-sm text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400">
            Sign out
          </button>
        </form>
      </header>
      {children}
    </div>
  );
}
