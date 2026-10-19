import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  STORAGE_DIR: z.string().min(1),
  // Chrome or Chromium binary. Google Chrome is recommended in production.
  CHROME_PATH: z.string().min(1),
  // Meet is more likely to let a visible browser in; run under Xvfb on the server.
  BOT_HEADLESS: z.enum(["true", "false"]).default("false"),
  // Chrome profile signed in to the bot's own Google account (see `pnpm login`).
  // Meet refuses many signed-out guests; when set, the bot joins as that account.
  BOT_PROFILE_DIR: z.string().min(1).optional(),
  // The name Meet shows for the bot's Google account, so the bot leaves itself out of attendee lists.
  BOT_ACCOUNT_NAME: z.string().min(1).default("Minute Flow"),
  // How many meetings this worker records at once (each is one browser).
  BOT_CONCURRENCY: z.coerce.number().int().positive().default(2),
  // Join this many seconds before the scheduled start.
  BOT_JOIN_EARLY_S: z.coerce.number().int().nonnegative().default(60),
  // Transcribes recordings when set. Without it, recordings are kept but not transcribed.
  DEEPGRAM_API_KEY: z.string().min(1).optional(),
  // Languages Deepgram can't auto-detect, tried explicitly when detection isn't confident English (comma-separated).
  TRANSCRIBE_EXTRA_LANGUAGES: z.string().default("bn"),
  // Writes AI notes (summary, decisions, action items) when set.
  GROQ_API_KEY: z.string().min(1).optional(),
  GROQ_MODEL: z.string().min(1).optional(),
  // Who writes the notes: groq (needs GROQ_API_KEY) or gemini (needs GEMINI_API_KEY).
  NOTES_PROVIDER: z.enum(["groq", "gemini"]).default("groq"),
  // "true" also writes a Bangla copy of every call's notes.
  NOTES_BANGLA: z.enum(["true", "false"]).default("false"),
  // Who transcribes calls: deepgram (Deepgram, with TRANSCRIBE_BANGLA_PROVIDER for non-English calls) or
  // gemini (Gemini writes every call and tells voices apart; Deepgram only steps in if Gemini fails).
  TRANSCRIPTION_PROVIDER: z.enum(["deepgram", "gemini"]).default("deepgram"),
  // Who transcribes calls that aren't clearly English (Bangla, or Bangla mixed with English).
  // deepgram: Deepgram's Bangla model. whisper: Groq's Whisper. gemini: Gemini (needs GEMINI_API_KEY).
  TRANSCRIBE_BANGLA_PROVIDER: z.enum(["deepgram", "whisper", "gemini"]).default("deepgram"),
  GEMINI_API_KEY: z.string().min(1).optional(),
  // Shared with the web app; decrypts the Gemini keys users save in Settings.
  TOKEN_ENCRYPTION_KEY: z.string().min(1).optional(),
  GEMINI_MODEL: z.string().min(1).default("gemini-3.8-flash"),
  GROQ_WHISPER_MODEL: z.string().min(1).default("whisper-large-v3"),
});

export const config = schema.parse(process.env);
export const headless = config.BOT_HEADLESS === "true";
