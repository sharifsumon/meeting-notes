import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";

export default async function Home() {
  const session = await auth();
  if (session?.user) redirect("/meetings");

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-8 px-6">
      <div className="space-y-3">
        <h1 className="text-4xl font-semibold tracking-tight">MinuteFlow</h1>
        <p className="text-lg text-zinc-600 dark:text-zinc-400">
          Connect your calendar, send a note-taker to your meetings, and get the transcript, summary and action
          items afterwards.
        </p>
      </div>
      <form
        action={async () => {
          "use server";
          await signIn("google", { redirectTo: "/meetings" });
        }}
      >
        <button
          type="submit"
          className="rounded-lg bg-zinc-900 px-5 py-3 font-medium text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Sign in with Google
        </button>
      </form>
      <p className="text-sm text-zinc-500">
        We ask for read-only access to your calendar so we can see which meetings to join.
      </p>
    </main>
  );
}
