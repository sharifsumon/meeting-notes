import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  STORAGE_DIR: z.string().min(1),
  // Chrome or Chromium binary. Google Chrome is recommended in production.
  CHROME_PATH: z.string().min(1),
  // Meet is more likely to let a visible browser in; run under Xvfb on the server.
  BOT_HEADLESS: z.enum(["true", "false"]).default("false"),
  // How many meetings this worker records at once (each is one browser).
  BOT_CONCURRENCY: z.coerce.number().int().positive().default(2),
  // Join this many seconds before the scheduled start.
  BOT_JOIN_EARLY_S: z.coerce.number().int().nonnegative().default(60),
});

export const config = schema.parse(process.env);
export const headless = config.BOT_HEADLESS === "true";
