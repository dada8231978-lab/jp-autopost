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

  # Persist the publish history. data/published.json drives topic rotation and
  # internal linking; data/articles holds the bodies `npm run reddit` uses.
  # Never fails the run - the article is already published by this point, and a
  # git problem must not be reported as a publishing failure.
  if [ -d .git ]; then
    git add data/history data/published.json data/articles || true
    if git diff --cached --quiet; then
      echo "git: nothing to commit"
    else
      git commit -m "chore: record published article [skip ci]" || true
      branch=$(git rev-parse --abbrev-ref HEAD)
      if git remote get-url origin >/dev/null 2>&1; then
        # A cloud run may have landed while this one was generating.
        git pull --rebase --autostash origin "$branch" || true
        git push origin "$branch" || echo "git: push failed - commit kept locally"
      else
        echo "git: no origin remote, skipping push"
      fi
    fi
  fi

  echo "=== $(date -Is) finished ==="
} >>"$LOG" 2>&1
