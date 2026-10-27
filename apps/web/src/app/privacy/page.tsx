import type { Metadata } from "next";
import { CONTACT_EMAIL, LegalPage } from "@/components/legal-page";

export const metadata: Metadata = { title: "Privacy policy · MinuteFlow" };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy" updated="18 October 2026">
      <p>
        MinuteFlow joins your Google Meet calls as a notetaker, records them, and writes transcripts, summaries and
        meeting minutes for you. This page explains what data we use, why, and how you control it.
      </p>

      <h2>Data we collect</h2>
      <ul>
        <li>
          <strong>Your Google account basics:</strong> your name, email address and profile picture, used to sign you in.
        </li>
        <li>
          <strong>Your calendar events (read-only):</strong> titles, start and end times, and Google Meet links of events
          on the calendars you turn on. We use them to show your meetings and to know which calls the notetaker should
          join. We never create, change or delete calendar events.
        </li>
        <li>
          <strong>Meeting recordings:</strong> the audio of calls you send the notetaker to, plus the names Google Meet
          shows for the people in the call and who was speaking when (from Meet&apos;s captions).
        </li>
        <li>
          <strong>Transcripts and notes</strong> we create from those recordings.
        </li>
      </ul>

      <h2>How we use it</h2>
      <p>
        Only to provide MinuteFlow to you: listing your meetings, sending the notetaker to the calls you choose, and
        producing transcripts, summaries and minutes. We don&apos;t sell your data, show you ads, or use your data to
        train AI models.
      </p>

      <h2>Google user data</h2>
      <p>
        MinuteFlow&apos;s use and transfer of information received from Google APIs adheres to the{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>,
        including the Limited Use requirements. Calendar data is used only to find and show your meetings. It is not
        shared with anyone else, and it is never sent to an AI service.
      </p>
      <p>
        We do not use data obtained through Google Workspace APIs, including your Google Calendar data, to develop,
        improve or train generalized or non-personalized AI or machine-learning models. We do not retain it for that
        purpose, and we do not let any third party use it for that purpose.
      </p>

      <h2>Services that process data for us</h2>
      <ul>
        <li>Google (Gemini) turns recordings into transcripts, with Deepgram as a backup.</li>
        <li>Google (Gemini) writes summaries and minutes from transcripts.</li>
      </ul>
      <p>They process the data only to return results to us, under their own data-protection terms.</p>

      <h2>Who can see a meeting</h2>
      <p>
        You can see the meetings on your own calendars. When the same call is on another MinuteFlow user&apos;s calendar,
        only one notetaker joins, and everyone who had the call on their calendar can see its recording, transcript and
        notes. The notetaker posts a message in the call&apos;s chat so the people in the call know it is recording.
      </p>

      <h2>Keeping and deleting data</h2>
      <p>
        We keep recordings, transcripts and notes until you delete them. Deleting a meeting in MinuteFlow removes its
        recording, transcript and notes from our servers right away. To delete your account and all its data, email us.
        You can also remove MinuteFlow&apos;s access to your Google account at any time at{" "}
        <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.
      </p>

      <h2>Security</h2>
      <p>
        Data is sent over encrypted connections, and the Google access tokens we store are encrypted. Recordings can only
        be played by people who can see the meeting.
      </p>

      <h2>Contact</h2>
      <p>
        Questions or deletion requests: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>
    </LegalPage>
  );
}
