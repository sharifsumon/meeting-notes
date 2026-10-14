#!/usr/bin/env bash
# Pulls the latest code, migrates the database, builds and restarts the web app.
# Run as root on the server: sudo /opt/meetingnotes/app/deploy/deploy.sh [branch]
set -euo pipefail

APP_DIR=/opt/meetingnotes/app
ENV_FILE=/root/meeting-notes.env
BRANCH=${1:-main}

# Package scripts call bare `pnpm`, so put it on PATH (no-op if already enabled).
corepack enable pnpm

as_app() { sudo -u meetingnotes -H bash -c "cd $APP_DIR && $*"; }

as_app "git fetch origin $BRANCH && git checkout $BRANCH && git reset --hard origin/$BRANCH"
as_app "pnpm install --frozen-lockfile"

# Migrations and build need the secrets; pass them through without making the file readable.
set -a; source "$ENV_FILE"; set +a
sudo -u meetingnotes -H --preserve-env=DATABASE_URL bash -c "cd $APP_DIR && pnpm db:migrate"
sudo -u meetingnotes -H bash -c "cd $APP_DIR && pnpm build"

install -m 644 "$APP_DIR/deploy/meetingnotes-web.service" /etc/systemd/system/meetingnotes-web.service
systemctl daemon-reload
systemctl enable meetingnotes-web
systemctl restart meetingnotes-web
sleep 3
curl -fsS http://127.0.0.1:3000/api/health && echo
