import { describe, expect, it } from "vitest";
import { normalizeGoogleEvent } from "./normalize";

const base = {
  id: "evt1",
  summary: "Weekly sync",
  start: { dateTime: "2026-10-14T09:00:00Z" },
  end: { dateTime: "2026-10-14T09:30:00Z" },
};

describe("normalizeGoogleEvent", () => {
  it("uses hangoutLink for Meet events", () => {
    expect(normalizeGoogleEvent({ ...base, hangoutLink: "https://meet.google.com/abc-defg-hij" })).toMatchObject({
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      platform: "google_meet",
      startsAt: new Date("2026-10-14T09:00:00Z"),
      cancelled: false,
    });
  });

  it("uses the conference video entry point", () => {
    const event = {
      ...base,
      conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+1" }, { entryPointType: "video", uri: "https://zoom.us/j/123" }] },
    };
    expect(normalizeGoogleEvent(event)).toMatchObject({ meetingUrl: "https://zoom.us/j/123", platform: "zoom" });
  });

  it("falls back to links in the location or description", () => {
    const event = { ...base, description: "Dial in: https://teams.microsoft.com/l/meetup-join/abc" };
    expect(normalizeGoogleEvent(event)?.platform).toBe("microsoft_teams");
  });

  it("keeps meetings without a link", () => {
    expect(normalizeGoogleEvent(base)).toMatchObject({ meetingUrl: null, platform: null });
  });

  it("skips all-day events", () => {
    expect(normalizeGoogleEvent({ id: "x", start: { date: "2026-10-14" }, end: { date: "2026-10-15" } })).toBeNull();
  });

  it("gives untitled events a placeholder title", () => {
    expect(normalizeGoogleEvent({ ...base, summary: "  " })?.title).toBe("(No title)");
  });
});
