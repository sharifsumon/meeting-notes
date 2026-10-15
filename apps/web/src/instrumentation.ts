/** Runs once when the Next.js server starts. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.DISABLE_BACKGROUND_SYNC === "true") return;
  const { startBackgroundSync } = await import("@/lib/sync");
  startBackgroundSync();
}
