#!/usr/bin/env bash
# Deploys all canisters to the local replica, passing the two whitelisted
# Internet Identity Principals (read from the gitignored .env, never from a
# tracked file) as the backend's #[init] argument. See CLAUDE.md Phase 5.1.
#
# Pillar 21 (Master Fuel Pump): the backend needs the frontend canister ID
# so it can monitor and auto-top-up the frontend's cycle balance. We deploy
# backend twice in the initial pass: once with a placeholder so the canister
# exists and the frontend can reference it, then again with the real frontend
# ID once the frontend is deployed. Both deploys just run post_upgrade (fast,
# no recompile). Finally, we grant the backend controller status over the
# frontend so canister_status calls succeed.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

set -a
source .env
set +a

# .env's DFX_NETWORK is for the app's own runtime code (server.js/App.js) to
# know whether it's talking to mainnet — it's routinely 'ic' since that's
# .env's normal production value. `set -a` above exports it along with
# everything else, and dfx's CLI itself respects that same env var as its
# target network whenever a command doesn't pass --network explicitly. None
# of the dfx deploy calls below do, so without this override, sourcing .env
# could silently point this "local-only" script's deploys at mainnet instead
# — confirmed live 2026-07-10 (a deploy failed on the mainnet-identity
# plaintext-security check, not because anything was actually wrong locally).
export DFX_NETWORK=local

if [[ -z "${COMMANDER_PRINCIPAL:-}" || -z "${PARTNER_PRINCIPAL:-}" ]]; then
  echo "COMMANDER_PRINCIPAL and PARTNER_PRINCIPAL must be set in .env" >&2
  exit 1
fi

dfx deploy internet_identity

# First backend deploy — use anonymous principal as frontend placeholder so
# the canister exists before the frontend (which depends on it for bindings).
# 2vxsx-fae is the IC anonymous principal in text encoding.
dfx deploy skippy_mmucc_backend \
  --argument "(principal \"${COMMANDER_PRINCIPAL}\", principal \"${PARTNER_PRINCIPAL}\", principal \"2vxsx-fae\")" \
  --upgrade-unchanged

dfx deploy skippy_mmucc_frontend

# Second backend deploy — now that the frontend is deployed, pass its real
# canister ID so the pump timer knows what to monitor.
FRONTEND_ID=$(dfx canister id skippy_mmucc_frontend)
dfx deploy skippy_mmucc_backend \
  --argument "(principal \"${COMMANDER_PRINCIPAL}\", principal \"${PARTNER_PRINCIPAL}\", principal \"${FRONTEND_ID}\")" \
  --upgrade-unchanged

# Grant the backend controller status over the frontend.
# canister_status on the IC management canister requires the caller to be a
# controller of the target — without this, the pump's balance check will be
# rejected. --add-controller is idempotent (safe to re-run on upgrades).
BACKEND_ID=$(dfx canister id skippy_mmucc_backend)
dfx canister update-settings skippy_mmucc_frontend --add-controller "${BACKEND_ID}"

echo ""
echo "Deploy complete."
echo "  Backend  (master tank):  ${BACKEND_ID}"
echo "  Frontend (pumped):       ${FRONTEND_ID}"
echo "  Backend is a controller of frontend — fuel pump active."
