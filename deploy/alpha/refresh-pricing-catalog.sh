#!/usr/bin/env bash
set -euo pipefail

repo_dir="${ACU_ROUTER_REPO_DIR:-/root/jerry/claw-router}"
env_file="${ACU_RUNTIME_ENV_FILE:-/root/jerry/new-api/.env}"

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

: "${POSTGRES_ACU_PASSWORD:?POSTGRES_ACU_PASSWORD is required}"
: "${POSTGRES_NEWAPI_PASSWORD:?POSTGRES_NEWAPI_PASSWORD is required}"

docker run --rm \
  --network acu-router-alpha_alpha-backend \
  --volume "$repo_dir:/repo" \
  --volume "acu-router-alpha_acu-pricing-runtime:/var/lib/acu/pricing" \
  --workdir /repo \
  --env POSTGRES_ACU_PASSWORD \
  --env POSTGRES_NEWAPI_PASSWORD \
  --env ACU_ADMIN_TRACE_TOKEN \
  --env ACU_ROUTER_INTERNAL_URL=http://acu-router:8403 \
  --env ACU_NEWAPI_DATABASE_URL="postgresql://newapi_alpha:${POSTGRES_NEWAPI_PASSWORD}@postgres-newapi:5432/newapi_alpha" \
  --env "ACU_RETAIL_MARKUP_MULTIPLIER=${ACU_RETAIL_MARKUP_MULTIPLIER:-1.25}" \
  --env "ACU_BILLING_POLICY_VERSION=${ACU_BILLING_POLICY_VERSION:-acu-retail-v1}" \
  --env ACU_PRICING_RUNTIME_CATALOG_FILE=/var/lib/acu/pricing/newapi-acu-catalog.json \
  node:22-bookworm \
  sh -lc 'export ACU_PRICING_RUNTIME_DATABASE_URL="postgresql://acu_alpha:${POSTGRES_ACU_PASSWORD}@postgres-acu:5432/acu_alpha"; exec node_modules/.bin/tsx tools/provider-channels/sync-newapi-channel-status.ts'
