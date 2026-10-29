import { describe, expect, it } from "vitest";
import { normalizeOutlookEvent, outlookGuestEmails } from "./normalize";

const base = {
  id: "evt1",
  subject: "Weekly sync",
  start: { dateTime: "2026-10-14T09:00:00.0000000" },
  end: { dateTime: "2026-10-14T09:30:00.0000000" },
};

describe("normalizeOutlookEvent", () => {
  it("reads Graph's UTC times and the Teams join link", () => {
    const event = { ...base, onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/abc" } };
    expect(normalizeOutlookEvent(event)).toMatchObject({
      startsAt: new Date("2026-10-14T09:00:00Z"),
      endsAt: new Date("2026-10-14T09:30:00Z"),
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/abc",
      platform: "microsoft_teams",
      cancelled: false,
    });
  });

  it("finds a Meet link in the body", () => {
    const event = { ...base, body: { content: '<a href="https://meet.google.com/abc-defg-hij">Join</a>' } };
    expect(normalizeOutlookEvent(event)).toMatchObject({ meetingUrl: "https://meet.google.com/abc-defg-hij", platform: "google_meet" });
  });

  it("skips all-day events", () => {
    expect(normalizeOutlookEvent({ ...base, isAllDay: true })).toBeNull();
  });
});

describe("outlookGuestEmails", () => {
  it("lists organizer and guests once, without rooms", () => {
    expect(
      outlookGuestEmails({
        id: "e",
        organizer: { emailAddress: { address: "Sharif@Example.com" } },
        attendees: [
          { emailAddress: { address: "sharif@example.com" }, type: "required" },
          { emailAddress: { address: "room@example.com" }, type: "resource" },
          { emailAddress: { address: "Rafat@example.com" }, type: "optional" },
        ],
      }),
    ).toEqual(["sharif@example.com", "rafat@example.com"]);
  });
});
