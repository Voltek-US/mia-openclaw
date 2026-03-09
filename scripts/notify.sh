#!/usr/bin/env bash
# notify.sh — Shell wrapper for the OpenClaw notification priority queue.
#
# Usage:
#   notify.sh [OPTIONS] <message>
#   notify.sh --flush --tier high|medium|critical
#
# Options:
#   --tier    critical|high|medium   Priority tier (default: $NOTIFY_TIER or "medium")
#   --channel <channel>              Target channel (default: $NOTIFY_CHANNEL)
#   --topic   <topic>                Optional topic/group label for digest
#   --type    <msgType>              Message type for classification rules
#   --bypass                         Send immediately, skipping the queue
#   --flush                          Flush pending messages for the given tier
#
# Environment variables:
#   NOTIFY_TIER      Default tier (critical|high|medium). Default: medium
#   NOTIFY_CHANNEL   Default channel. Required unless --channel is passed.
#   OPENCLAW_BIN     Path to the openclaw binary. Default: openclaw

set -euo pipefail

OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
tier="${NOTIFY_TIER:-medium}"
channel="${NOTIFY_CHANNEL:-}"
topic=""
msg_type=""
flush_mode=0
bypass_mode=0
message=""

# ─── Argument parsing ────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tier)
      tier="$2"
      shift 2
      ;;
    --channel)
      channel="$2"
      shift 2
      ;;
    --topic)
      topic="$2"
      shift 2
      ;;
    --type)
      msg_type="$2"
      shift 2
      ;;
    --bypass)
      bypass_mode=1
      shift
      ;;
    --flush)
      flush_mode=1
      shift
      ;;
    --)
      shift
      message="$*"
      break
      ;;
    -*)
      echo "notify.sh: unknown option: $1" >&2
      exit 1
      ;;
    *)
      message="$1"
      shift
      ;;
  esac
done

# ─── Validate tier ───────────────────────────────────────────────────────────

case "$tier" in
  critical|high|medium) ;;
  *)
    echo "notify.sh: invalid tier '${tier}'. Must be: critical, high, or medium" >&2
    exit 1
    ;;
esac

# ─── Flush mode ──────────────────────────────────────────────────────────────

if [[ "$flush_mode" -eq 1 ]]; then
  exec "$OPENCLAW_BIN" notify flush --tier "$tier"
fi

# ─── Enqueue mode ────────────────────────────────────────────────────────────

if [[ -z "$message" ]]; then
  echo "notify.sh: no message provided" >&2
  echo "Usage: notify.sh [--tier TIER] [--channel CHANNEL] [--topic TOPIC] <message>" >&2
  exit 1
fi

if [[ -z "$channel" ]]; then
  echo "notify.sh: no channel specified. Use --channel or set NOTIFY_CHANNEL" >&2
  exit 1
fi

# Build the argument list.
args=(notify enqueue --channel "$channel" --tier "$tier")

if [[ -n "$topic" ]]; then
  args+=(--topic "$topic")
fi

if [[ -n "$msg_type" ]]; then
  args+=(--type "$msg_type")
fi

if [[ "$bypass_mode" -eq 1 ]]; then
  args+=(--bypass)
fi

args+=("$message")

# Critical failures should surface; high/medium failures are non-blocking.
if [[ "$tier" == "critical" ]]; then
  exec "$OPENCLAW_BIN" "${args[@]}"
else
  "$OPENCLAW_BIN" "${args[@]}" || {
    echo "notify.sh: warning: failed to enqueue [${tier}] notification (non-fatal)" >&2
  }
fi
