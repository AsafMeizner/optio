#!/usr/bin/env bash
# Render the chart without a cluster.
set -euo pipefail
cd "$(dirname "$0")/../../.."
helm lint helm/optio \
  --set publicUrl=https://optio.example.com \
  --set encryption.key=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --set postgresql.auth.password=render-only
helm template optio helm/optio --kube-version 1.33.0 \
  --set publicUrl=https://optio.example.com \
  --set encryption.key=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --set postgresql.auth.password=render-only >/dev/null
