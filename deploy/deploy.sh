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
sudo -u meetingnotes -H bash -c "cd $APP_DIR && pnpm build"

# The bot needs Google Chrome and a virtual display.
if ! command -v google-chrome >/dev/null || ! command -v xvfb-run >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq xvfb wget
  wget -qO /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y -qq /tmp/google-chrome.deb
  rm -f /tmp/google-chrome.deb
fi

for svc in meetingnotes-web meetingnotes-bot; do
  install -m 644 "$APP_DIR/deploy/$svc.service" "/etc/systemd/system/$svc.service"
done
systemctl daemon-reload
systemctl enable meetingnotes-web meetingnotes-bot
systemctl restart meetingnotes-web meetingnotes-bot
sleep 3
curl -fsS http://127.0.0.1:3000/api/health && echo
