DROP INDEX "bot_sessions_meeting_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "bot_sessions_meeting_idx" ON "bot_sessions" USING btree ("meeting_id");