#!/usr/bin/env bash
# Builds and deploys exactly one named Worker environment (README "Deploying").
#   production  → claude-rental-commerce-platform   (--env production)
#   staging     → rental-commerce-staging           (--env staging)
#   development → rental-commerce-development       (top-level config)
# There is deliberately no default: a deploy without a target never runs.
set -euo pipefail
cd "$(dirname "$0")/.."

target="${1:-}"
case "$target" in
  production | staging) env_args=(--env "$target") expected_cf_env="$target" ;;
  development)
    # Cloudflare connected builds (WORKERS_CI=1) rename whatever they deploy to the connected
    # project's Worker, i.e. production. The development config must never go out that way.
    if [[ -n "${WORKERS_CI:-}" ]]; then
      echo "✗ refusing to deploy the development config from a Cloudflare build (it would replace production)" >&2
      exit 1
    fi
    env_args=() expected_cf_env=""
    ;;
  *)
    echo "usage: scripts/deploy.sh <production|staging|development>" >&2
    exit 1
    ;;
esac

# Wrangler also selects an environment from CLOUDFLARE_ENV; a conflicting value is an error.
if [[ "${CLOUDFLARE_ENV:-}" != "$expected_cf_env" ]]; then
  echo "✗ CLOUDFLARE_ENV='${CLOUDFLARE_ENV:-}' conflicts with target '$target'" >&2
  exit 1
fi

echo "→ deploying $target"
pnpm exec opennextjs-cloudflare build ${env_args[@]+"${env_args[@]}"}
pnpm exec opennextjs-cloudflare deploy ${env_args[@]+"${env_args[@]}"}
