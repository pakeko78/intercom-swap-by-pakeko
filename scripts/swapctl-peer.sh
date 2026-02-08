#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

. scripts/_env.sh

STORE_NAME="${1:-}"
SC_PORT="${2:-}"
shift 2 || true

if [[ -z "$STORE_NAME" || -z "$SC_PORT" ]]; then
  echo "Usage: scripts/swapctl-peer.sh <storeName> <scBridgePort> <swapctl args...>" >&2
  echo "Example: scripts/swapctl-peer.sh swap-maker 49222 info" >&2
  exit 1
fi

TOKEN_FILE="onchain/sc-bridge/${STORE_NAME}.token"
if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "ERROR: missing SC-Bridge token file: $TOKEN_FILE" >&2
  echo "Hint: start the peer once so it generates a token (see scripts/run-swap-*.sh)." >&2
  exit 1
fi

SC_TOKEN="$(tr -d '\r\n' <"$TOKEN_FILE")"

KEYPAIR_FILE="stores/${STORE_NAME}/db/keypair.json"
if [[ -f "$KEYPAIR_FILE" ]]; then
  exec node scripts/swapctl.mjs --url "ws://127.0.0.1:${SC_PORT}" --token "$SC_TOKEN" --peer-keypair "$KEYPAIR_FILE" "$@"
fi

exec node scripts/swapctl.mjs --url "ws://127.0.0.1:${SC_PORT}" --token "$SC_TOKEN" "$@"
