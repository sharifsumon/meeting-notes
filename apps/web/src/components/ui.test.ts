import { describe, expect, it } from "vitest";
import { wasNotLetIn } from "./ui";

describe("wasNotLetIn", () => {
  it("tells a call that didn't admit the bot from a technical failure", () => {
    expect(wasNotLetIn("Not admitted: nobody let the bot in within 10 minutes")).toBe(true);
    expect(wasNotLetIn("The host didn't let the bot in")).toBe(true);
    expect(wasNotLetIn("Stopped waiting to be let in: a call you sent the bot to needed it")).toBe(true);
    expect(wasNotLetIn("Google Meet refused to let the bot in")).toBe(true);
    expect(wasNotLetIn("Bot crashed: TimeoutError")).toBe(false);
    expect(wasNotLetIn("Could not find the join button on the Meet lobby page")).toBe(false);
    expect(wasNotLetIn(null)).toBe(false);
  });
});
