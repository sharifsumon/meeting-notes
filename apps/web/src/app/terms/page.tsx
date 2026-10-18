import type { Metadata } from "next";
import Link from "next/link";
import { CONTACT_EMAIL, LegalPage } from "@/components/legal-page";

export const metadata: Metadata = { title: "Terms of service · MinuteFlow" };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of service" updated="18 October 2026">
      <p>By using MinuteFlow you agree to these terms.</p>

      <h2>The service</h2>
      <p>
        MinuteFlow sends a notetaker to the Google Meet calls you choose, records them, and writes transcripts, summaries
        and minutes. Transcripts and notes are written by automated systems and can contain mistakes; check anything
        important against the recording.
      </p>

      <h2>Recording consent</h2>
      <p>
        You are responsible for having the consent the law requires from everyone in a call before it is recorded. The
        notetaker joins under its own name, asks the host to let it in, and posts a message in the call&apos;s chat saying
        it is recording.
      </p>

      <h2>Your content</h2>
      <p>
        Recordings, transcripts and notes belong to you. You let us store and process them only to provide the service,
        as described in our <Link href="/privacy">privacy policy</Link>. You can delete them at any time.
      </p>

      <h2>Acceptable use</h2>
      <p>
        Don&apos;t use MinuteFlow to record people unlawfully, to break other services&apos; terms, or to interfere with the
        service. We may suspend accounts that do.
      </p>

      <h2>Availability</h2>
      <p>
        We work to keep MinuteFlow running, but it is provided as is, without guarantees that every call will be joined
        or recorded. To the extent the law allows, we aren&apos;t liable for indirect losses or for missed or incomplete
        recordings.
      </p>

      <h2>Changes</h2>
      <p>We may update these terms; the date above shows the latest version. Continuing to use MinuteFlow means you accept them.</p>

      <h2>Contact</h2>
      <p>
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      </p>
    </LegalPage>
  );
}
