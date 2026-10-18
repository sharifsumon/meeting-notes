import { meetCode } from "./meet/links";

type SharedCandidate = { url: string | null; startsAt: Date; endsAt: Date };
export type RecordedSession = { id: string; url: string | null; joinedAt: Date; leftAt: Date | null };

/** The bot session that was in this meeting's call (same Meet link, in the call during the meeting), if any. */
export function sharedSessionFor(m: SharedCandidate, sessions: RecordedSession[], now = new Date()): string | null {
  const code = meetCode(m.url);
  if (!code) return null;
  const match = sessions.find(
    (s) => meetCode(s.url) === code && s.joinedAt < m.endsAt && (s.leftAt ?? now) > m.startsAt,
  );
  return match?.id ?? null;
}
