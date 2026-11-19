#!/usr/bin/env bash
#
# Runs one of the cron jobs against the local dev server, as Vercel Cron does
# in production (it is not scheduled locally). For example, after a post's
# review failed and the post sits in "正在审核":
#
#   npm run cron:local -- posts          # /api/cron/posts (reviews, answers, sweeps)
#   npm run cron:local -- rank           # any other /api/cron/<name>
#
# CRON_SECRET comes from the environment, or else from .env.local (only that
# line is read, never printed). BASE defaults to http://localhost:3000.
set -euo pipefail
cd "$(dirname "$0")/.."
job="${1:-posts}"
base="${BASE:-http://localhost:3000}"
case "${base}" in
  http://localhost:*|http://127.0.0.1:*) ;;
  *) echo "cron:local only calls a local server, not ${base}" >&2; exit 1 ;;
esac
secret="${CRON_SECRET:-}"
if [[ -z "${secret}" && -f .env.local ]]; then
  secret="$(grep -E '^CRON_SECRET=' .env.local | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
fi
if [[ -z "${secret}" ]]; then
  echo "CRON_SECRET is not set (environment or .env.local)" >&2
  exit 1
fi
curl -sS --fail-with-body -H "authorization: Bearer ${secret}" "${base}/api/cron/${job}"
echo
