import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------------------------------------------------------------------------
// Auth.js tables (shape required by @auth/drizzle-adapter)
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("email_verified", { mode: "date", withTimezone: true }),
  image: text("image"),
  // When the user agreed to MinuteFlow reading their calendar and recording their Meet calls.
  // Nothing is recorded automatically before this is set.
  consentedAt: timestamp("consented_at", { withTimezone: true }),
  consentVersion: text("consent_version"),
  // Send the notetaker to every Google Meet event on the user's calendars.
  autoRecord: boolean("auto_record").notNull().default(true),
  // The user's own Gemini API key, encrypted like OAuth tokens. Their calls use it instead of the server's.
  geminiApiKey: text("gemini_api_key"),
  createdAt: createdAt(),
});

// access_token / refresh_token / id_token are stored encrypted (see apps/web/src/lib/crypto.ts).
export const accounts = pgTable(
  "accounts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date", withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date", withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

// ---------------------------------------------------------------------------
// Calendars and meetings
// ---------------------------------------------------------------------------

export const calendarProvider = pgEnum("calendar_provider", ["google", "microsoft"]);

export const meetingPlatform = pgEnum("meeting_platform", [
  "google_meet",
  "microsoft_teams",
  "zoom",
  "webex",
  "other",
]);

export const calendars = pgTable(
  "calendars",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: calendarProvider("provider").notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    // Per-calendar opt-in: only enabled calendars are synced.
    enabled: boolean("enabled").notNull().default(false),
    timeZone: text("time_zone"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("calendars_user_provider_external_idx").on(t.userId, t.provider, t.externalId)],
);

/** Title of meetings started from a pasted link until the bot learns the call's name. */
export const AD_HOC_MEETING_TITLE = "Meeting from link";

export const meetings = pgTable(
  "meetings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Null for meetings started from a pasted link ("Send bot now").
    calendarId: uuid("calendar_id").references(() => calendars.id, { onDelete: "cascade" }),
    externalEventId: text("external_event_id"),
    title: text("title").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    meetingUrl: text("meeting_url"),
    platform: meetingPlatform("platform"),
    cancelled: boolean("cancelled").notNull().default(false),
    // Whether the note-taker bot should join this meeting.
    recordEnabled: boolean("record_enabled").notNull().default(true),
    // Set by "Send bot now": the bot joins right away instead of at the start time.
    botRequestedAt: timestamp("bot_requested_at", { withTimezone: true }),
    // Set when the user deletes a calendar meeting. The row stays so calendar sync doesn't bring it back.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // Another MinuteFlow user's bot recorded this call (it was on both calendars), so this meeting
    // shows that recording, transcript and notes instead of sending a second bot.
    sharedSessionId: uuid("shared_session_id").references((): AnyPgColumn => botSessions.id, { onDelete: "set null" }),
    // A copy for a MinuteFlow user who was invited (matched by account email) to another user's
    // calendar event, so they see the call's recording even without the event on their own calendar.
    invitedFrom: uuid("invited_from").references((): AnyPgColumn => meetings.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("meetings_calendar_event_idx").on(t.calendarId, t.externalEventId),
    index("meetings_user_starts_idx").on(t.userId, t.startsAt),
  ],
);

// ---------------------------------------------------------------------------
// Capture and processing (filled in by the bot worker and pipeline)
// ---------------------------------------------------------------------------

export const botSessionStatus = pgEnum("bot_session_status", [
  "scheduled",
  "joining",
  "waiting_room",
  "recording",
  "processing",
  "completed",
  "failed",
  "cancelled",
]);

export type SpeakerTurn = { name: string; startMs: number; endMs: number };

export const botSessions = pgTable(
  "bot_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    status: botSessionStatus("status").notNull().default("scheduled"),
    // Path relative to STORAGE_DIR (local) or object key (S3).
    recordingKey: text("recording_key"),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    leftAt: timestamp("left_at", { withTimezone: true }),
    error: text("error"),
    // Who Meet's captions showed speaking, relative to the start of the recording.
    speakerTimeline: jsonb("speaker_timeline").$type<SpeakerTurn[]>().notNull().default([]),
    // Names seen in the call's People list.
    participants: jsonb("participants").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // One bot per meeting for now.
  (t) => [uniqueIndex("bot_sessions_meeting_idx").on(t.meetingId)],
);

export type TranscriptSegment = {
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
};

export const transcripts = pgTable("transcripts", {
  id: uuid("id").primaryKey().defaultRandom(),
  botSessionId: uuid("bot_session_id")
    .notNull()
    .unique()
    .references(() => botSessions.id, { onDelete: "cascade" }),
  language: text("language"),
  segments: jsonb("segments").$type<TranscriptSegment[]>().notNull().default([]),
  createdAt: createdAt(),
});

export type ActionItem = { text: string; owner?: string; dueDate?: string };
/** A minutes bullet; bullets nest up to three levels. */
export type MinutesPoint = { text: string; children?: MinutesPoint[] };
/** Formal meeting minutes: who attended, then numbered discussion topics. */
export type Minutes = { attendees: string[]; topics: { title: string; points: MinutesPoint[] }[] };
export type NoteContent = {
  summary: string;
  keyPoints: string[];
  decisions: string[];
  actionItems: ActionItem[];
  minutes?: Minutes;
};

export const notes = pgTable("notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  meetingId: uuid("meeting_id")
    .notNull()
    .unique()
    .references(() => meetings.id, { onDelete: "cascade" }),
  summary: text("summary").notNull().default(""),
  keyPoints: jsonb("key_points").$type<string[]>().notNull().default([]),
  decisions: jsonb("decisions").$type<string[]>().notNull().default([]),
  actionItems: jsonb("action_items").$type<ActionItem[]>().notNull().default([]),
  // Null for notes written before minutes existed.
  minutes: jsonb("minutes").$type<Minutes>(),
  // The same notes in other languages, by language code (Bangla calls get "bn" next to English).
  translations: jsonb("translations").$type<Record<string, NoteContent>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type User = typeof users.$inferSelect;
export type Calendar = typeof calendars.$inferSelect;
export type Meeting = typeof meetings.$inferSelect;
export type BotSession = typeof botSessions.$inferSelect;
