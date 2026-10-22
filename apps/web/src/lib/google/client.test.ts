import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("missingScope", () => {
  it("tells a missing calendar permission from other refusals", async () => {
    const { missingScope } = await import("./client");
    expect(
      missingScope(
        JSON.stringify({
          error: {
            code: 403,
            message: "Request had insufficient authentication scopes.",
            errors: [{ reason: "insufficientPermissions" }],
            details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
          },
        }),
      ),
    ).toBe(true);
    expect(missingScope(JSON.stringify({ error: { code: 403, errors: [{ reason: "rateLimitExceeded" }] } }))).toBe(false);
    expect(missingScope(JSON.stringify({ error: { code: 403, errors: [{ reason: "forbidden" }] } }))).toBe(false);
  });
});

describe("hasCalendarScope", () => {
  it("spots a sign-in where the calendar box was left unticked", async () => {
    const { hasCalendarScope } = await import("./client");
    expect(hasCalendarScope("https://www.googleapis.com/auth/userinfo.email openid https://www.googleapis.com/auth/userinfo.profile")).toBe(false);
    expect(hasCalendarScope("openid https://www.googleapis.com/auth/calendar.readonly")).toBe(true);
    expect(hasCalendarScope(null)).toBe(true);
  });

  it("needs both narrow calendar scopes", async () => {
    const { hasCalendarScope } = await import("./client");
    const list = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
    const events = "https://www.googleapis.com/auth/calendar.events.readonly";
    expect(hasCalendarScope(`openid ${list} ${events}`)).toBe(true);
    expect(hasCalendarScope(`openid ${events}`)).toBe(false);
    expect(hasCalendarScope(`openid ${list}`)).toBe(false);
  });
});
