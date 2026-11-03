#!/usr/bin/env bash
# First-time setup of the 1Password item that dokploy-rollout.sh reads. Run it once, where `op` can write.
# Generates the Wealthfolio password and encryption key and asks for the Dokploy API key. Without
# WF_SECRET_KEY the database and its backups can't be opened, so an existing item is never overwritten.
set -euo pipefail

VAULT=${WF_OP_VAULT:-env-devsrvr}
ITEM=wf-sync

if op item get "$ITEM" --vault "$VAULT" >/dev/null 2>&1; then
	echo "$VAULT/$ITEM already exists, nothing changed." >&2
	exit 1
fi

printf 'Dokploy API key of the target server: '
read -rs dokploy_key
echo
[ -n "$dokploy_key" ] || {
	echo 'No key entered, nothing changed.' >&2
	exit 1
}

op item create --vault "$VAULT" --title "$ITEM" --category 'API Credential' \
	"WF_PASSWORD[password]=$(openssl rand -hex 24)" \
	"WF_SECRET_KEY[password]=$(openssl rand -base64 32)" \
	"DOKPLOY_API_KEY[password]=$dokploy_key" >/dev/null
echo "Created $VAULT/$ITEM."
