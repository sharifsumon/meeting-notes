#!/usr/bin/env bash
# Pulls the latest code, migrates the database, builds and restarts the web app and meeting bot.
# Run as root on the server: sudo /opt/meetingnotes/app/deploy/deploy.sh [branch]
set -euo pipefail

APP_DIR=/opt/meetingnotes/app
ENV_FILE=/root/meeting-notes.env
BRANCH=${1:-main}

# Package scripts call bare `pnpm`, so put it on PATH (no-op if already enabled).
corepack enable pnpm

mkdir -p /var/lib/meetingnotes/bot-home && chown meetingnotes: /var/lib/meetingnotes/bot-home

as_app() { sudo -u meetingnotes -H bash -c "cd $APP_DIR && $*"; }

as_app "git fetch origin $BRANCH && git checkout $BRANCH && git reset --hard origin/$BRANCH"
# Bash keeps reading this file as it runs, so restart once with the version just pulled.
if [ -z "${DEPLOY_REEXEC:-}" ]; then DEPLOY_REEXEC=1 exec "$APP_DIR/deploy/deploy.sh" "$@"; fi
as_app "pnpm install --frozen-lockfile"

# Migrations and build need the secrets; pass them through without making the file readable.
set -a; source "$ENV_FILE"; set +a
sudo -u meetingnotes -H --preserve-env=DATABASE_URL bash -c "cd $APP_DIR && pnpm db:migrate"

# Build the web app into whichever of two folders isn't serving, so the running app keeps working
# during the build. A failed build stops here and leaves the old one running.
DIST_FILE=/var/lib/meetingnotes/web-dist.env
ACTIVE=$(sed -n 's/^NEXT_DIST_DIR=//p' "$DIST_FILE" 2>/dev/null || true)
if [ "$ACTIVE" = ".next-a" ]; then NEXT_DIST_DIR=.next-b; else NEXT_DIST_DIR=.next-a; fi
export NEXT_DIST_DIR
rm -rf "$APP_DIR/apps/web/$NEXT_DIST_DIR"
sudo -u meetingnotes -H --preserve-env=NEXT_DIST_DIR bash -c "cd $APP_DIR && pnpm build"

# The bot needs Google Chrome and a virtual display.
if ! command -v google-chrome >/dev/null || ! command -v xvfb-run >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq xvfb wget ffmpeg
  wget -qO /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y -qq /tmp/google-chrome.deb
  rm -f /tmp/google-chrome.deb
fi

# Bangla calls longer than ~25 MB are split with ffmpeg before transcription.
command -v ffmpeg >/dev/null || { apt-get update -qq && apt-get install -y -qq ffmpeg; }

for svc in meetingnotes-web meetingnotes-bot; do
  install -m 644 "$APP_DIR/deploy/$svc.service" "/etc/systemd/system/$svc.service"
done
systemctl daemon-reload
systemctl enable meetingnotes-web meetingnotes-bot
echo "NEXT_DIST_DIR=$NEXT_DIST_DIR" > "$DIST_FILE"
systemctl restart meetingnotes-web
sleep 3
curl -fsS http://127.0.0.1:3000/api/health && echo
# Keep the other build folder for a quick rollback; remove the old single-folder build.
rm -rf "$APP_DIR/apps/web/.next"

# Restarting the bot ends any call it is recording (the audio so far is kept). Wait for calls to
# finish first, up to BOT_WAIT_MINUTES (default 180).
BUSY_SQL="select count(*) from bot_sessions where status in ('joining', 'waiting_room', 'recording')"
for _ in $(seq "${BOT_WAIT_MINUTES:-180}"); do
  busy=$(psql "${DATABASE_URL%%\?*}" -tAc "$BUSY_SQL" 2>/dev/null || echo 0)
  [ "${busy:-0}" -eq 0 ] && break
  echo "Waiting for $busy bot call(s) to finish before restarting the bot..."
  sleep 60
done
systemctl restart meetingnotes-bot
echo "Deployed $(as_app "git rev-parse --short HEAD") (web build in $NEXT_DIST_DIR)"
