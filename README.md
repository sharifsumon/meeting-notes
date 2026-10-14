# MinuteFlow

A meeting note taker: connect your calendars, send a bot to your meetings, and get transcripts and AI notes afterwards. Live at https://minuteflow.tech.

## What's here

| Path | What it is |
|---|---|
| `apps/web` | Next.js web app: Google sign-in, calendar connect, upcoming meetings with a per-meeting "Record" toggle |
| `apps/bot` | Meeting bot worker: joins Google Meet calls marked "Record" as a guest, records the audio, leaves when the call ends |
| `packages/db` | Drizzle ORM schema and SQL migrations for PostgreSQL |
| `deploy/` | systemd unit and deploy script for the server |

Coming next: transcripts and AI notes for recorded meetings, then Teams and Zoom.

## How the bot works

Every 20 seconds the bot worker looks for Google Meet meetings with Record on that start within a minute, creates a `bot_sessions` row and queues a join job in Redis (BullMQ). The job opens Chrome, joins as "Notetaker for <first name>", waits for the host to admit it, posts a recording notice in the chat, and records every participant's audio by tapping Meet's WebRTC audio tracks. It leaves when everyone else has gone, when it's removed, or an hour after the scheduled end. Audio is saved as WebM/Opus under `STORAGE_DIR/<user id>/<bot session id>.webm`, and the session is left in `processing` for transcription.

Run it locally with `CHROME_PATH=/path/to/chrome pnpm --filter @minuteflow/bot start`. Its tests drive a real browser against a fake Meet page (`apps/bot/test/fake-meet.html`) when `CHROME_PATH` is set.

## Local development

Needs Node 22+, pnpm (`corepack enable`), and PostgreSQL.

```sh
pnpm install
cp .env.example .env           # fill in the values
set -a; source .env; set +a
pnpm db:migrate
pnpm dev                       # http://localhost:3000
```

Other commands: `pnpm test`, `pnpm typecheck`, `pnpm build`, and `pnpm db:generate` after changing `packages/db/src/schema.ts`.

## Google OAuth setup

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Calendar API**.
2. Configure the **OAuth consent screen**: External, add the scope `.../auth/calendar.readonly`, and add yourself as a test user. (Public launch needs Google verification because calendar access is a sensitive scope.)
3. Create an **OAuth client ID** of type *Web application* with these authorized redirect URIs:
   - `https://minuteflow.tech/api/auth/callback/google`
   - `http://localhost:3000/api/auth/callback/google`
4. Put the client ID and secret in `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`.

## Security notes

- OAuth access and refresh tokens are encrypted at rest with AES-256-GCM (`TOKEN_ENCRYPTION_KEY`); the ID token isn't stored.
- Calendar access is read-only. Users choose which calendars are watched; only the primary one is on by default.
- Never commit `.env` files. On the server, secrets live in `/root/meeting-notes.env`.

## Deploying

The server runs the app as the `meetingnotes` user behind Caddy on port 3000. First time:

```sh
# as root
mkdir -p /opt/meetingnotes && chown meetingnotes: /opt/meetingnotes
sudo -u meetingnotes git clone https://github.com/sharifsumon/meeting-notes /opt/meetingnotes/app
# add AUTH_SECRET, AUTH_URL, AUTH_TRUST_HOST, AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET and TOKEN_ENCRYPTION_KEY
# to /root/meeting-notes.env (see .env.example)
/opt/meetingnotes/app/deploy/deploy.sh
```

After that, `deploy/deploy.sh [branch]` pulls, migrates, builds and restarts. Health check: `GET /api/health`.
