export type MeetingPlatform = "google_meet" | "microsoft_teams" | "zoom" | "webex" | "other";

const PATTERNS: Array<{ platform: Exclude<MeetingPlatform, "other">; re: RegExp }> = [
  { platform: "google_meet", re: /https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:\?[^\s<>"']*)?/i },
  {
    platform: "microsoft_teams",
    re: /https:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/[^\s<>"']+/i,
  },
  { platform: "zoom", re: /https:\/\/(?:[\w-]+\.)?zoom\.us\/(?:j|my|w)\/[^\s<>"']+/i },
  { platform: "webex", re: /https:\/\/[\w-]+\.webex\.com\/[^\s<>"']+/i },
];

export type DetectedMeeting = { url: string; platform: MeetingPlatform };

/**
 * Finds the first known video-meeting link in free text (location, description, ...).
 * Texts are checked in order; within a text, the earliest link wins.
 */
export function detectMeetingLink(...texts: Array<string | null | undefined>): DetectedMeeting | null {
  for (const text of texts) {
    if (!text) continue;
    let best: { index: number; found: DetectedMeeting } | null = null;
    for (const { platform, re } of PATTERNS) {
      const match = re.exec(text);
      if (match && (!best || match.index < best.index)) {
        best = { index: match.index, found: { url: trimTrailingPunctuation(match[0]), platform } };
      }
    }
    if (best) return best.found;
  }
  return null;
}

export function platformForUrl(url: string): MeetingPlatform {
  return detectMeetingLink(url)?.platform ?? "other";
}

function trimTrailingPunctuation(url: string) {
  return url.replace(/[).,;]+$/, "");
}
