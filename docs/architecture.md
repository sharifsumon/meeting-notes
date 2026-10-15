# Architecture and scaling plan

## Today: one self-hosted Google Meet bot

MinuteFlow records calls with its own bot (`apps/bot`): a Chrome browser driven by Playwright that joins the
call, captures the audio and writes it to `STORAGE_DIR`. The web app schedules work by inserting a
`bot_sessions` row; the bot worker picks it up from the Redis queue and updates the row's status as it goes
(`scheduled → joining → waiting_room → recording → processing → completed | failed`).

This is meant for the owner's and their team's meetings, a few at a time:

- **Server.** Each bot is a full Chrome. One peaked at about 750 MB of RAM, so the current VPS (1 CPU, 3.8 GB)
  runs 1–2 calls at once (`BOT_CONCURRENCY=1`).
- **Google account.** Meet blocks signed-out bots, so the bot joins as its own Google account
  (`BOT_PROFILE_DIR`). One account can't sit in many calls at once without Google flagging it.
- **Browser profile.** A signed-in Chrome profile can only be open in one browser at a time, so every parallel
  bot needs its own copy.

## Later: hundreds of calls

Recording sits behind one boundary so it can be swapped without touching the rest of the app. Everything
outside the bot only knows about `bot_sessions` (status, `recordingKey`, timings) and the recording file.
New recorders should implement the same contract:

```ts
interface RecordingProvider {
  /** Ask for a recorder to join `meetingUrl` between `startsAt` and `endsAt`. Returns the provider's job id. */
  schedule(meeting: { id: string; meetingUrl: string; startsAt: Date; endsAt: Date; botName: string }): Promise<string>;
  /** Cancel a job that hasn't finished. */
  cancel(jobId: string): Promise<void>;
  /** Current state, mapped onto bot_session_status. */
  status(jobId: string): Promise<{ status: BotSessionStatus; error?: string }>;
  /** Copy the finished recording into storage and return its key. */
  fetchRecording(jobId: string): Promise<string>;
}
```

The self-hosted Meet bot is the first implementation. Two candidates for scale:

- **A. A meeting-bot service** such as Recall.ai. It runs the bot fleet for Meet, Teams and Zoom and sends the
  recording back by webhook; billed per recorded hour. Fastest path to many concurrent calls on all three
  platforms.
- **B. The platforms' own recordings**: Google Meet REST API (Workspace), Zoom cloud recordings, Microsoft
  Teams via Graph. No browsers at all, but each customer needs recording turned on and an admin to approve
  access.

Transcription and AI notes run after `fetchRecording`, so they don't change with the provider.
