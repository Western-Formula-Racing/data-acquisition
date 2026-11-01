#!/usr/bin/env bash
# dd-rebuild-cron.sh — auto-sync the data-downloader services in the installer
# Docker stack on the WFR DAQ production VPS when origin/main advances.
#
# The downloader runs as part of the `installer` compose project
# (server/installer/docker-compose.yml) — NOT the standalone
# data-downloader/docker-compose.yml. All compose commands therefore run from
# server/installer and use the installer service names:
#   data-downloader-api, data-downloader-frontend, data-downloader-scanner.
#
# Cron-driven and safe for a multi-developer workflow:
#   * a flock prevents two rebuilds from racing,
#   * only ever FAST-FORWARDS origin/main; refuses on a dirty tracked tree, a
#     wrong branch, or a divergence (a human is mid-edit) rather than doing a
#     destructive reset,
#   * rebuilds ONLY the three data-downloader services and passes --no-deps, so
#     it NEVER recreates timescaledb (recreating the DB bounces the team's
#     telemetry store and reverts its memory config),
#   * a health gate on /api/health + /api/states rolls the deploy back to the
#     previous commit if the new stack comes up broken.
#
# Untracked files (e.g. .env, *.bak) are intentionally NOT a refusal reason:
# `git reset --hard` never removes untracked files, so they are safe.
#
# Install once on the VPS (run as the deploy user who can `docker compose`
# without sudo — `ubuntu` here):
#   sudo install -m 0755 \
#       ~/projects/data-acquisition/server/installer/data-downloader/scripts/dd-rebuild-cron.sh \
#       /usr/local/bin/dd-rebuild-cron.sh
#   # systemd units live alongside this script (dd-rebuild-cron.service/.timer):
#   sudo install -m 0644 \
#       ~/projects/data-acquisition/server/installer/data-downloader/scripts/dd-rebuild-cron.service \
#       /etc/systemd/system/dd-rebuild-cron.service
#   sudo install -m 0644 \
#       ~/projects/data-acquisition/server/installer/data-downloader/scripts/dd-rebuild-cron.timer \
#       /etc/systemd/system/dd-rebuild-cron.timer
#   sudo systemctl daemon-reload
#   sudo systemctl enable --now dd-rebuild-cron.timer

set -euo pipefail

REPO_DIR="${DD_REPO_DIR:-/home/ubuntu/projects/data-acquisition}"
INSTALLER_DIR="${DD_INSTALLER_DIR:-${REPO_DIR}/server/installer}"
TRACKED_BRANCH="${DD_BRANCH:-origin/main}"
HEALTH_TIMEOUT_SECONDS="${DD_HEALTH_TIMEOUT_SECONDS:-60}"
LOCK_PATH="${DD_LOCK_PATH:-/var/lock/dd-rebuild.lock}"
LOG_TAG="dd-rebuild-cron"
SERVICES=(data-downloader-api data-downloader-frontend data-downloader-scanner)

# Cron/systemd run in a minimal env; make sure git + docker are on PATH.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

log() {
    # Single-line journal-friendly output:
    #   journalctl -u dd-rebuild-cron -t dd-rebuild-cron
    printf '%s [%s] %s\n' "$(date -u +%FT%TZ)" "${LOG_TAG}" "$*"
}

# Single-instance guard: a slow build must not overlap the next timer tick.
exec 9>"${LOCK_PATH}"
if ! flock -n 9; then
    log "lock held by another rebuild; exiting"
    exit 0
fi

cd "${REPO_DIR}"

# Must be on the tracked branch.
branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "${branch}" != "${TRACKED_BRANCH#origin/}" ]; then
    log "ERROR: checkout is on '${branch}', not '${TRACKED_BRANCH#origin/}'; refusing"
    exit 1
fi

# Never reset over local edits to TRACKED files.
if ! git diff --quiet HEAD; then
    log "ERROR: working tree has uncommitted tracked changes; refusing to reset"
    exit 1
fi

CURRENT_SHA="$(git rev-parse --verify HEAD)"
log "current deploy sha: ${CURRENT_SHA:0:7}"

git fetch --quiet origin "${TRACKED_BRANCH#origin/}"
LATEST_SHA="$(git rev-parse --verify "${TRACKED_BRANCH}")"

if [ "${LATEST_SHA}" = "${CURRENT_SHA}" ]; then
    log "no new commits on ${TRACKED_BRANCH}; nothing to do (${CURRENT_SHA:0:7})"
    exit 0
fi

# Fast-forward only: if HEAD is not an ancestor of the upstream tip, someone has
# diverged the checkout — refuse rather than clobber their work.
if ! git merge-base --is-ancestor "${CURRENT_SHA}" "${LATEST_SHA}"; then
    log "ERROR: HEAD (${CURRENT_SHA:0:7}) is not an ancestor of ${TRACKED_BRANCH} (${LATEST_SHA:0:7}); refusing"
    exit 1
fi

log "new commits on ${TRACKED_BRANCH}: ${CURRENT_SHA:0:7}..${LATEST_SHA:0:7}"
PREVIOUS_SHA="${CURRENT_SHA}"
git reset --hard "${LATEST_SHA}" >/dev/null
log "fast-forwarded to ${LATEST_SHA:0:7}"

# Rebuild ONLY the data-downloader services, from the installer compose project,
# with --no-deps so timescaledb is never recreated.
deploy() {
    cd "${INSTALLER_DIR}"
    local svc
    for svc in "${SERVICES[@]}"; do
        log "building ${svc}"
        docker compose build "${svc}"
    done
    log "recreating (--no-deps): ${SERVICES[*]}"
    docker compose up -d --no-deps "${SERVICES[@]}"
}

HEALTH_URL="${DD_HEALTH_URL:-http://localhost:8000/api/health}"
STATES_URL="${DD_STATES_URL:-http://localhost:8000/api/states}"

# Wait up to HEALTH_TIMEOUT_SECONDS for a URL to return 2xx.
wait_for_200() {
    local url="$1" deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))
    while [ "$(date +%s)" -lt "${deadline}" ]; do
        if curl --silent --fail --max-time 5 -o /dev/null "${url}"; then
            return 0
        fi
        sleep 2
    done
    return 1
}

# /api/health must come up, and /api/states (the analytics-v2 endpoint) must
# answer a valid season cleanly — that doubles as proof the module mounted.
is_healthy() {
    if ! wait_for_200 "${HEALTH_URL}"; then
        log "/api/health never returned 200 within ${HEALTH_TIMEOUT_SECONDS}s"
        return 1
    fi
    if ! curl --silent --fail --max-time 10 -X POST \
            -H 'Content-Type: application/json' \
            -d '{"season":"wfr25","start":"2000-01-01T00:00:00Z","end":"2000-01-02T00:00:00Z"}' \
            -o /dev/null "${STATES_URL}"; then
        log "/api/states did not respond cleanly; treating as unhealthy"
        return 1
    fi
    return 0
}

deploy
if is_healthy; then
    log "deploy ${LATEST_SHA:0:7} is healthy"
    exit 0
fi

# Rollback: we're already on LATEST_SHA; revert to the previous commit and
# rebuild once more. NOTE: this leaves the checkout on PREVIOUS_SHA while
# origin/main stays at the bad LATEST_SHA, so the next tick will retry the bad
# commit. A persistently-broken main commit needs a human to fix/revert.
log "rolling back to ${PREVIOUS_SHA:0:7}"
cd "${REPO_DIR}"
git reset --hard "${PREVIOUS_SHA}" >/dev/null
deploy
if is_healthy; then
    log "rollback to ${PREVIOUS_SHA:0:7} is healthy"
    exit 1
fi

log "ERROR: rollback to ${PREVIOUS_SHA:0:7} also unhealthy — manual intervention required"
exit 2
