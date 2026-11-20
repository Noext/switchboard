#!/usr/bin/env bash
#
# Generic deployment helper: pull the latest code on a remote host and wait for /healthz.
#
# All values are environment-overridable, so the script is not tied to any particular host.
# The default transport assumes you can run docker compose on the target directly over SSH.
# If your setup needs something else (Proxmox `pct exec`, a jump host, …), override DEPLOY_CMD.
#
# Usage:
#   DEPLOY_HOST=deploy@example.com APP_DIR=/opt/switchboard \
#   HEALTH_URL=https://switchboard.example.com/healthz ./scripts/deploy.sh
#
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:?set DEPLOY_HOST (e.g. root@switchboard.example.com)}"
APP_DIR="${APP_DIR:-/opt/switchboard}"
HEALTH_URL="${HEALTH_URL:?set HEALTH_URL (e.g. https://switchboard.example.com/healthz)}"
TIMEOUT="${TIMEOUT:-180}"

# Command run on the remote host. Override for Proxmox LXC, systemd units, etc.
DEPLOY_CMD="${DEPLOY_CMD:-cd '${APP_DIR}' && git pull --ff-only && docker compose up -d --build}"

echo "==> Deploying to ${DEPLOY_HOST} (${APP_DIR})"
ssh "${DEPLOY_HOST}" "bash -lc \"${DEPLOY_CMD}\""

echo "==> Waiting for ${HEALTH_URL}"
for i in $(seq 1 "${TIMEOUT}"); do
  if curl -fsS --max-time 3 "${HEALTH_URL}" >/dev/null 2>&1; then
    echo "==> Healthy after ${i}s"
    curl -fsS "${HEALTH_URL}" | head -c 2000
    echo
    exit 0
  fi
  sleep 1
done

echo "!! Switchboard did not become healthy within ${TIMEOUT}s" >&2
exit 1
