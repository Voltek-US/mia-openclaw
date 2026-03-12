#!/bin/bash
# Daily upstream sync: merge openclaw/openclaw into Voltek-US/mia-openclaw
# Run via cron or manually. Notifies on conflict.
#
# Usage: sync-upstream.sh [--notify]
#   --notify  Send Telegram alert on conflict or failure

set -euo pipefail

REPO="git@github.com:Voltek-US/mia-openclaw.git"
UPSTREAM="https://github.com/openclaw/openclaw.git"
WORK_DIR="/tmp/mia-upstream-sync-$$"
NOTIFY="${1:-}"

cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

echo "[$(date -Iseconds)] Starting upstream sync..."

# Clone fork
git clone --quiet "$REPO" "$WORK_DIR"
cd "$WORK_DIR"

# Add upstream
git remote add upstream "$UPSTREAM"
git fetch upstream --quiet

# Check if there are new commits
BEHIND=$(git rev-list main..upstream/main --count 2>/dev/null || echo "0")
if [ "$BEHIND" = "0" ]; then
    echo "Already up to date with upstream."
    exit 0
fi

echo "$BEHIND commits behind upstream. Merging..."

# Get upstream version for commit message
UPSTREAM_VER=$(git show upstream/main:package.json | python3 -c "import json,sys;print(json.load(sys.stdin).get('version','unknown'))" 2>/dev/null || echo "unknown")

# Attempt merge
if git merge upstream/main --no-edit -m "chore: daily upstream sync (openclaw v${UPSTREAM_VER}, +${BEHIND} commits)" 2>&1; then
    echo "Merge succeeded. Pushing..."
    git push origin main
    echo "[$(date -Iseconds)] Sync complete: +${BEHIND} commits from upstream v${UPSTREAM_VER}"
else
    # Conflicts detected
    CONFLICTS=$(git diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ', ')
    git merge --abort 2>/dev/null || true

    echo "CONFLICT: Merge failed. Conflicting files: $CONFLICTS"

    if [ "$NOTIFY" = "--notify" ]; then
        # This will be picked up by Mia's heartbeat or can be sent directly
        echo "UPSTREAM_SYNC_CONFLICT|$BEHIND|$UPSTREAM_VER|$CONFLICTS" > /tmp/mia-sync-conflict.flag
    fi

    exit 1
fi
