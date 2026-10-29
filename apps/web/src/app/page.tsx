import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import { LegalLinks } from "@/components/legal-page";
import { Icon, Logo, MicrosoftMark } from "@/components/ui";
import { microsoftEnabled } from "@/env";
import { MICROSOFT_PROVIDER } from "@/lib/microsoft/client";

const POINTS = [
  "Syncs with your Google or Outlook calendar",
  "Read-only calendar access, never edits your events",
  "Recordings, transcripts and notes in one place",
];

const SIGN_IN_ERRORS: Record<string, string> = {
  OAuthAccountNotLinked:
    "That email already has a MinuteFlow account. Sign in the way you did before, then connect the other account in Settings.",
};

export default async function Home({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const session = await auth();
  if (session?.user) redirect(error ? `/settings?error=${encodeURIComponent(error)}` : "/meetings");
  const withMicrosoft = microsoftEnabled();

  return (
    <div className="flex min-h-screen flex-wrap">
      <section className="flex flex-[1_1_420px] flex-col justify-between gap-12 border-line bg-rail px-6 py-10 md:border-r md:px-14 md:py-12">
        <div className="flex items-center gap-2.5">
          <Logo size={36} />
          <span className="text-[22px] font-extrabold tracking-[-0.02em]">MinuteFlow</span>
        </div>
        <div className="flex max-w-[460px] flex-col gap-5">
          <h1 className="text-[34px] leading-[1.15] font-extrabold tracking-[-0.03em] md:text-[40px]">
            Every meeting, written up for you.
          </h1>
          <p className="text-[17px] leading-relaxed text-ink-3">
            MinuteFlow joins your Google Meet calls, records them, and turns them into summaries, decisions and action
            items you can come back to.
          </p>
          <ul className="mt-2 flex flex-col gap-3.5 text-[15px] text-ink-2">
            {POINTS.map((p) => (
              <li key={p} className="flex items-center gap-3">
                <span className="flex size-7 flex-none items-center justify-center rounded-lg bg-green-100 text-green-800">
                  <Icon name="check" size={16} strokeWidth={2.4} />
                </span>
                {p}
              </li>
            ))}
          </ul>
        </div>
        <LegalLinks />
      </section>
      <section className="flex flex-[1_1_480px] items-center justify-center px-6 py-12">
        <div className="card flex w-full max-w-[420px] flex-col gap-6 rounded-2xl p-9 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_rgba(15,23,42,0.06)]">
          <div className="flex flex-col gap-1.5">
            <h2 className="text-2xl font-bold tracking-[-0.02em]">Sign in to MinuteFlow</h2>
            <p className="text-sm text-muted">Use the account your meetings live in.</p>
          </div>
          {error && (
            <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              {SIGN_IN_ERRORS[error] ?? "Sign-in didn't finish. Please try again."}
            </p>
          )}
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/meetings" });
            }}
          >
            <button
              type="submit"
              className="flex min-h-12 w-full items-center gap-3 rounded-[10px] border border-line bg-white px-4 text-[15px] font-semibold hover:bg-page"
            >
              <span className="flex size-[26px] items-center justify-center rounded-full border border-line text-[13px] font-extrabold text-blue-600">
                G
              </span>
              Continue with Google
            </button>
          </form>
          {withMicrosoft && (
            <form
              className="-mt-3"
              action={async () => {
                "use server";
                await signIn(MICROSOFT_PROVIDER, { redirectTo: "/meetings" });
              }}
            >
              <button
                type="submit"
                className="flex min-h-12 w-full items-center gap-3 rounded-[10px] border border-line bg-white px-4 text-[15px] font-semibold hover:bg-page"
              >
                <span className="flex size-[26px] items-center justify-center">
                  <MicrosoftMark size={18} />
                </span>
                Continue with Microsoft
              </button>
            </form>
          )}
          <p className="text-[13px] leading-relaxed text-muted">
            We ask for read-only access to your calendar so we can see which meetings to join. See our{" "}
            <Link href="/privacy" className="text-accent underline">
              privacy policy
            </Link>
            .
          </p>
        </div>
      </section>
    </div>
  );
}
