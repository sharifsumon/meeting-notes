import "server-only";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(1),
  AUTH_GOOGLE_ID: z.string().min(1),
  AUTH_GOOGLE_SECRET: z.string().min(1),
  TOKEN_ENCRYPTION_KEY: z.string().min(1),
});

let cached: z.infer<typeof schema> | undefined;

/** Server env, validated on first use so `next build` works without secrets. */
export function env() {
  cached ??= schema.parse(process.env);
  return cached;
}
