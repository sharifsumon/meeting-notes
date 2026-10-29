import "server-only";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(1),
  AUTH_GOOGLE_ID: z.string().min(1),
  AUTH_GOOGLE_SECRET: z.string().min(1),
  TOKEN_ENCRYPTION_KEY: z.string().min(1),
  // Optional: "Continue with Microsoft" appears only when both are set.
  AUTH_MICROSOFT_ENTRA_ID_ID: z.string().min(1).optional(),
  AUTH_MICROSOFT_ENTRA_ID_SECRET: z.string().min(1).optional(),
  STORAGE_DIR: z.string().min(1).default("/var/lib/meetingnotes/recordings"),
});

let cached: z.infer<typeof schema> | undefined;

/** Server env, validated on first use so `next build` works without secrets. */
export function env() {
  cached ??= schema.parse(process.env);
  return cached;
}

/** Whether Microsoft sign-in is configured on this server. */
export function microsoftEnabled() {
  return Boolean(env().AUTH_MICROSOFT_ENTRA_ID_ID && env().AUTH_MICROSOFT_ENTRA_ID_SECRET);
}
