#!/usr/bin/env bash
# Guards against the most damaging configuration mistakes (ARCHITECTURE.md §6.4).
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0

# 1. The service-role key may only be read by the env module and the system client.
if grep -rn "SUPABASE_SERVICE_ROLE_KEY" src --include='*.ts' --include='*.tsx' \
   | grep -vE '^src/server/(env|db/system)\.ts:'; then
  echo "✗ SUPABASE_SERVICE_ROLE_KEY referenced outside src/server/env.ts and src/server/db/system.ts"; fail=1
fi

# 2. Nothing secret-looking may be exposed to the browser via NEXT_PUBLIC_.
if grep -rhoE "NEXT_PUBLIC_[A-Z0-9_]+" src .env.example | sort -u \
   | grep -E "SECRET|SERVICE|PRIVATE|PASSWORD|OPENAI|TOKEN"; then
  echo "✗ secret-looking NEXT_PUBLIC_ variable"; fail=1
fi

# 3. No committed env files or obvious key material.
if git ls-files | grep -E '(^|/)\.env($|\.)' | grep -v '\.env\.example$'; then
  echo "✗ committed .env file"; fail=1
fi
if git grep -nE "sb_secret_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{32,}|-----BEGIN (RSA |EC )?PRIVATE KEY-----" -- ':!*.md' ':!scripts/check-secrets.sh'; then
  echo "✗ possible secret committed"; fail=1
fi

[[ $fail -eq 0 ]] && echo "✓ secret checks passed"
exit $fail
