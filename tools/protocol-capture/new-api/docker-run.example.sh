#!/usr/bin/env bash
set -euo pipefail

: "${NEW_API_IMAGE_DIGEST:?set the immutable calciumion/new-api image digest}"
: "${NEW_API_SESSION_SECRET:?set a test-only random session secret}"
: "${NEW_API_DATA_DIR:?set an absolute isolated data directory}"
: "${NEW_API_LOG_DIR:?set an absolute isolated log directory}"

mkdir -p "$NEW_API_DATA_DIR" "$NEW_API_LOG_DIR"

docker run --detach \
  --name acu-protocol-recon-new-api \
  --restart unless-stopped \
  --publish 127.0.0.1:3100:3000 \
  --env "SESSION_SECRET=$NEW_API_SESSION_SECRET" \
  --env TZ=Europe/Berlin \
  --env ERROR_LOG_ENABLED=true \
  --env MEMORY_CACHE_ENABLED=false \
  --mount "type=bind,src=$NEW_API_DATA_DIR,dst=/data" \
  --mount "type=bind,src=$NEW_API_LOG_DIR,dst=/app/logs" \
  "calciumion/new-api@$NEW_API_IMAGE_DIGEST" \
  --log-dir /app/logs
