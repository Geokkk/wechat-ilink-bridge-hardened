#!/usr/bin/env bash
# wxb cleanup - Periodic maintenance script for WeChat iLink Bridge
# 
# This script runs `wxb cleanup` with default retention settings:
#   - Message retention: 30 days (WX_MESSAGE_RETENTION_DAYS)
#   - Attachment retention: 30 days (WX_ATTACHMENT_RETENTION_DAYS)
#   - Max history messages: 10000 (WX_MAX_HISTORY_MESSAGES)
#
# These match the upstream defaults. Override via environment variables if needed.
#
# Scheduling:
#   - Linux/macOS: Add to crontab (crontab -e)
#     Example: Run daily at 3:00 AM
#     0 3 * * * /path/to/cleanup.sh >> /var/log/wxb-cleanup.log 2>&1
#   - systemd timer: Create /etc/systemd/system/wxb-cleanup.service and .timer
#   - Windows: Use Task Scheduler (see cleanup.ps1)
#
# IMPORTANT: The state directory contains credentials (bot tokens, context tokens).
# Do NOT back up the state directory to any git repository or shared location.
# If you need backups, encrypt them and store securely.

set -euo pipefail

# Resolve script directory to find wxb if installed locally
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Use local wxb if available, otherwise assume wxb is in PATH
if [[ -f "$PROJECT_ROOT/src/cli/index.js" ]]; then
    WXB_CMD="node $PROJECT_ROOT/src/cli/index.js"
else
    WXB_CMD="wxb"
fi

# State directory - override with WX_STATE_DIR if needed
# Default: ~/.local/share/wxb (Linux), ~/Library/Application Support/wxb (macOS)
: "${WX_STATE_DIR:=$HOME/.local/share/wxb}"

echo "[$(date)] Starting wxb cleanup..."
echo "State directory: $WX_STATE_DIR"

# Run cleanup with default retention values (can be overridden via env vars)
"$WXB_CMD" cleanup \
    --state-dir "$WX_STATE_DIR" \
    --message-retention-days "${WX_MESSAGE_RETENTION_DAYS:-30}" \
    --attachment-retention-days "${WX_ATTACHMENT_RETENTION_DAYS:-30}" \
    --max-history-messages "${WX_MAX_HISTORY_MESSAGES:-10000}" \
    --json

CLEANUP_EXIT=$?
if [[ $CLEANUP_EXIT -eq 0 ]]; then
    echo "[$(date)] Cleanup completed successfully"
else
    echo "[$(date)] Cleanup failed with exit code $CLEANUP_EXIT" >&2
    exit $CLEANUP_EXIT
fi