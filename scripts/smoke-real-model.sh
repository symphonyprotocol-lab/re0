#!/usr/bin/env bash
#
# Smoke test on the real models (tests/smoke/real-model.test.ts), in a
# throwaway database like the integration suite. The models are the local
# dev database's enabled ones: their rows (keys still sealed) are read once,
# read-only, from the dev container, and only the two lines that open and
# price them are taken from .env.local -- never a database URL from it.
#
#   ./scripts/smoke-real-model.sh
#   SMOKE_SOURCE_CONTAINER=re0-dev-pg PG_PORT=5481 WS_PORT=5482 ./scripts/smoke-real-model.sh
#
# It calls the real providers and costs real (small) money.
set -euo pipefail
cd "$(dirname "$0")/.."
source_container="${SMOKE_SOURCE_CONTAINER:-re0-dev-pg}"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# The enabled free generation model and embedding model, as JSON rows (keys sealed); nothing is written.
docker exec "${source_container}" psql -U postgres -d re0 -At -c \
  "select coalesce(json_agg(m), '[]') from model_config m where (kind = 'generation' and enabled) or (kind = 'embedding' and enabled)" \
  > "${work}/models.json"
# The local unit prices too, so owner-billed calls (example questions) are made and metered as locally.
docker exec "${source_container}" psql -U postgres -d re0 -At -c \
  "select coalesce(json_agg(p), '[]') from provider_pricing p" \
  > "${work}/prices.json"

# .env.local here, or in the main checkout when this is a git worktree (SMOKE_ENV_FILE to name another).
env_file="${SMOKE_ENV_FILE:-.env.local}"
if [[ ! -f "${env_file}" ]]; then
  main="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
  [[ -f "${main}/.env.local" ]] && env_file="${main}/.env.local"
fi
read_local() {
  [[ -f "${env_file}" ]] || return 0
  { grep -E "^$1=" "${env_file}" || true; } | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}
admin_key="${ADMIN_SECRET_KEY:-$(read_local ADMIN_SECRET_KEY)}"
credential_key="${CREDENTIAL_ENCRYPTION_KEY:-$(read_local CREDENTIAL_ENCRYPTION_KEY)}"
rates="${PROVIDER_COST_RATES:-$(read_local PROVIDER_COST_RATES)}"

SMOKE_REAL_MODEL=1 SMOKE_MODEL_CONFIGS="${work}/models.json" SMOKE_PRICES="${work}/prices.json" SMOKE_LOG="${work}/smoke.log" \
ADMIN_SECRET_KEY="${admin_key}" CREDENTIAL_ENCRYPTION_KEY="${credential_key}" PROVIDER_COST_RATES="${rates}" \
PG_CONTAINER="${PG_CONTAINER:-re0-smoke-pg}" PG_PORT="${PG_PORT:-5481}" WS_PORT="${WS_PORT:-5482}" \
  ./scripts/test-integration.sh tests/smoke/real-model.test.ts || status=$?
echo
echo "== smoke results =="
cat "${work}/smoke.log" 2>/dev/null || echo "(no results written)"
exit "${status:-0}"
