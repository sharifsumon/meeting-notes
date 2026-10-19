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
