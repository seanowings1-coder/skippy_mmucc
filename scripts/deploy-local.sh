#!/usr/bin/env bash
# Deploys all canisters to the local replica, passing the two whitelisted
# Internet Identity Principals (read from the gitignored .env, never from a
# tracked file) as the backend's #[init] argument. See CLAUDE.md Phase 5.1.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

set -a
source .env
set +a

if [[ -z "${COMMANDER_PRINCIPAL:-}" || -z "${PARTNER_PRINCIPAL:-}" ]]; then
  echo "COMMANDER_PRINCIPAL and PARTNER_PRINCIPAL must be set in .env" >&2
  exit 1
fi

dfx deploy internet_identity
dfx deploy skippy_mmucc_backend --argument "(principal \"${COMMANDER_PRINCIPAL}\", principal \"${PARTNER_PRINCIPAL}\")"
dfx deploy skippy_mmucc_frontend
