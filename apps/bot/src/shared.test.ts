import { describe, expect, it } from "vitest";
import { sharedSessionFor } from "./shared";

const at = (hhmm: string) => new Date(`2026-10-18T${hhmm}:00Z`);
const meeting = { url: "https://meet.google.com/vry-epwj-ssz", startsAt: at("04:00"), endsAt: at("04:30") };

describe("sharedSessionFor", () => {
  it("finds the bot that was in the same call during the meeting", () => {
    const sessions = [
      { id: "other-call", url: "https://meet.google.com/abc-defg-hij", joinedAt: at("04:01"), leftAt: at("04:20") },
      { id: "same-call", url: "https://meet.google.com/vry-epwj-ssz?authuser=1", joinedAt: at("04:01"), leftAt: at("04:20") },
    ];
    expect(sharedSessionFor(meeting, sessions)).toBe("same-call");
  });

  it("ignores a bot from another day's call on the same link", () => {
    const sessions = [{ id: "yesterday", url: meeting.url, joinedAt: at("01:00"), leftAt: at("01:30") }];
    expect(sharedSessionFor(meeting, sessions)).toBeNull();
  });

  it("counts a bot still in the call", () => {
    const sessions = [{ id: "live", url: meeting.url, joinedAt: at("04:05"), leftAt: null }];
    expect(sharedSessionFor(meeting, sessions, at("04:10"))).toBe("live");
  });
});
