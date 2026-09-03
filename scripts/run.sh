#!/usr/bin/env bash
# Linux/macOS cron entry point. Logs to logs/post-<date>.log.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

mkdir -p logs
LOG="logs/post-$(date +%Y-%m-%d).log"

{
  echo "=== $(date -Is) starting ==="
  npx tsx src/index.ts "$@"
  echo "=== $(date -Is) finished ==="
} >>"$LOG" 2>&1
