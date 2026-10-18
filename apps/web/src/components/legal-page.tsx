import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/ui";

/** Layout for the public privacy policy and terms pages. */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-page">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-[760px] items-center gap-2.5 px-4 py-4 md:px-8">
          <Link href="/" className="flex items-center gap-2.5">
            <Logo size={28} />
            <span className="text-lg font-extrabold tracking-[-0.02em]">MinuteFlow</span>
          </Link>
        </div>
      </header>
      <main className="mx-auto flex max-w-[760px] flex-col gap-6 px-4 py-10 text-[15px] leading-relaxed text-ink-2 md:px-8 [&_h2]:mt-4 [&_h2]:text-lg [&_h2]:font-bold [&_h2]:text-ink [&_li]:ml-5 [&_li]:list-disc [&_a]:text-accent [&_a]:underline">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[30px] font-extrabold tracking-[-0.02em] text-ink">{title}</h1>
          <p className="text-sm text-muted">Last updated {updated}</p>
        </div>
        {children}
      </main>
      <LegalLinks className="mx-auto max-w-[760px] px-4 pb-10 md:px-8" />
    </div>
  );
}

export const CONTACT_EMAIL = "privacy@minuteflow.tech";

export function LegalLinks({ className = "" }: { className?: string }) {
  return (
    <p className={`flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted ${className}`}>
      <span>© {new Date().getFullYear()} MinuteFlow</span>
      <Link href="/privacy" className="hover:text-ink">
        Privacy policy
      </Link>
      <Link href="/terms" className="hover:text-ink">
        Terms of service
      </Link>
    </p>
  );
}
