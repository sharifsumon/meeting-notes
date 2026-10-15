ALTER TABLE "meetings" ALTER COLUMN "record_enabled" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "bot_sessions" ADD COLUMN "speaker_timeline" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_sessions" ADD COLUMN "participants" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "consented_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "consent_version" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auto_record" boolean DEFAULT true NOT NULL;