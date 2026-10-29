import { describe, expect, it } from "vitest";
import { detectMeetingLink, meetCode, platformForUrl } from "./meeting-links";

describe("detectMeetingLink", () => {
  it("finds a Google Meet link", () => {
    expect(detectMeetingLink("Join: https://meet.google.com/abc-defg-hij.")).toEqual({
      url: "https://meet.google.com/abc-defg-hij",
      platform: "google_meet",
    });
  });

  it("finds a Teams link inside HTML", () => {
    const html =
      '<a href="https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d">Join</a>';
    expect(detectMeetingLink(html)?.platform).toBe("microsoft_teams");
    expect(detectMeetingLink(html)?.url).not.toContain('"');
  });

  it("finds Zoom links on vanity subdomains", () => {
    expect(detectMeetingLink("https://acme.zoom.us/j/1234567890?pwd=xyz")).toEqual({
      url: "https://acme.zoom.us/j/1234567890?pwd=xyz",
      platform: "zoom",
    });
  });

  it("finds Webex links", () => {
    expect(detectMeetingLink("https://acme.webex.com/meet/jane")?.platform).toBe("webex");
  });

  it("checks texts in order and skips empty ones", () => {
    expect(
      detectMeetingLink(null, "", "Room 4", "notes https://zoom.us/j/1 and https://meet.google.com/abc-defg-hij")
        ?.platform,
    ).toBe("zoom");
  });

  it("returns null when there is no meeting link", () => {
    expect(detectMeetingLink("Lunch at https://example.com")).toBeNull();
  });
});

describe("platformForUrl", () => {
  it("falls back to other", () => {
    expect(platformForUrl("https://example.com/call")).toBe("other");
  });
});

describe("meetCode", () => {
  it("extracts the code whatever the link looks like", () => {
    expect(meetCode("https://meet.google.com/ofw-zegm-ueq?authuser=1")).toBe("ofw-zegm-ueq");
    expect(meetCode("https://MEET.google.com/OFW-ZEGM-UEQ/")).toBe("ofw-zegm-ueq");
    expect(meetCode("https://zoom.us/j/123")).toBeNull();
    expect(meetCode(null)).toBeNull();
  });
});

describe("completeMeetingLink", () => {
  it("accepts a Meet link without https, or the bare code", async () => {
    const { completeMeetingLink, detectMeetingLink } = await import("./meeting-links");
    for (const typed of ["meet.google.com/qqj-qvck-fgd", " qqj-qvck-fgd ", "http://meet.google.com/qqj-qvck-fgd", "https://meet.google.com/qqj-qvck-fgd", "https://meet.google.com/qqj-qvck-fgd/"]) {
      expect(detectMeetingLink(completeMeetingLink(typed))?.url).toBe("https://meet.google.com/qqj-qvck-fgd");
    }
    expect(detectMeetingLink(completeMeetingLink("meet.google.com/qqj-qvck-fgd?authuser=0"))?.url).toBe(
      "https://meet.google.com/qqj-qvck-fgd?authuser=0",
    );
    expect(detectMeetingLink(completeMeetingLink("Transcom kickoff"))).toBeNull();
  });
});
