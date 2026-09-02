#!/bin/bash
# Live proof that a manual steer works from observe mode and records before it
# sends. Run with the thread id as $1; prints every timestamp the report cites.
#
# The waits are the point: the ledger reconciles on a one-minute schedule, so
# the thread has to stay busy long enough for obs_thread.status to read
# `active` before `watch steer` looks at it. The task must block in the
# foreground - a backgrounded command returns the turn immediately and the
# thread goes idle.
set -u
TID="$1"
DB="$HOME/.bb/plugins/observatory/data.db"
BB="env -u BB_CLI bb"

echo "== starting a long foreground turn"
# Streamed output, not a shell command: Claude Code backgrounds a long bash
# call and the turn ends immediately, which leaves the thread idle.
$BB thread tell "$TID" \
  "Write out every number from 1 to 5000, one per line, directly in your reply. Do not use any tools and do not abbreviate." \
  --mode steer >/dev/null

echo "== waiting for the ledger to see it active"
for _ in $(seq 1 40); do
  sleep 5
  ROW=$(sqlite3 -readonly "$DB" "select status from obs_thread where thread_id='$TID';")
  echo "  obs_thread.status=$ROW  ($(date -u +%H:%M:%S))"
  [ "$ROW" = "active" ] && break
done

echo "== watch mode (must be observe)"
$BB observatory status | grep watch_mode

echo "== manual steer from observe at $(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
$BB observatory watch steer "$TID" --note "QA proof: manual steer from observe mode"
echo "exit=$?"

echo "== obs_action rows"
sqlite3 -readonly "$DB" \
  "select id, at, action, result, detail from obs_action where thread_id='$TID' order by id desc limit 5;"

echo "== the steer message in the thread log"
$BB thread log "$TID" --all --json 2>/dev/null \
  | grep -E '"createdAt"|QA proof: manual steer' \
  | grep -B 1 "QA proof: manual steer" \
  | tail -6
