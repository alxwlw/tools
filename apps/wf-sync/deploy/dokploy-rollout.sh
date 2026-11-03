#!/usr/bin/env bash
# Deploys or updates Wealthfolio + wf-sync as a compose app of the Dokploy on this host. Safe to re-run.
# Run it from apps/wf-sync/deploy. The env comes from 1Password (op-init.sh creates the item), config.yaml
# from WF_SYNC_CONFIG_FILE: it holds no secrets, only ${NAME} references to that env.
# Secrets reach neither argv nor the screen: values stay in shell variables and go to other programs on
# stdin; the API key goes through a mode-600 curl config removed on exit.
set -euo pipefail

OP_ITEM=${WF_OP_ITEM:-op://env-devsrvr/wf-sync}
CONFIG_FILE=${WF_SYNC_CONFIG_FILE:-$HOME/.config/wf-sync/config.yaml}
COMPOSE_FILE=docker-compose.dokploy.yml
DOKPLOY_URL=${DOKPLOY_URL:-http://127.0.0.1:3000}
UI_PORT=${WF_UI_PORT:-8445}
TIME_ZONE=${WF_TZ:-Europe/Kyiv}
PROJECT=wf-sync
APP=wealthfolio
# Added to the 1Password item as each connector is switched on; absent ones are skipped.
CONNECTOR_VARS=(
	BINANCE_API_KEY BINANCE_SECRET
	OKX_API_KEY OKX_SECRET OKX_PASSPHRASE
	KRAKEN_API_KEY KRAKEN_SECRET
	WHITEBIT_API_KEY WHITEBIT_SECRET
	BYBIT_API_KEY BYBIT_SECRET
	ZERION_API_KEY
	MONOBANK_TOKEN
)

die() {
	echo "rollout: $*" >&2
	exit 1
}

[ -f "$COMPOSE_FILE" ] || die "no $COMPOSE_FILE here: run from apps/wf-sync/deploy"
[ -f "$CONFIG_FILE" ] || die "no config at $CONFIG_FILE"

required_field() {
	local value
	value=$(op read "$OP_ITEM/$1" 2>/dev/null) && [ -n "$value" ] || die "cannot read $OP_ITEM/$1 (op signed in? vault readable here? op-init.sh run?)"
	printf '%s' "$value"
}

# One dotenv line. Single quotes keep every $ of the password hash literal.
env_block=""
add_env() {
	case $2 in
	*\'* | *$'\n'*) die "$1 contains a single quote or a newline, which the env block can't carry" ;;
	esac
	env_block+="$1='$2'"$'\n'
	echo "  env $1"
}

echo '1Password: reading fields, nothing is printed'
wf_password=$(required_field WF_PASSWORD)
wf_secret_key=$(required_field WF_SECRET_KEY)
dokploy_key=$(required_field DOKPLOY_API_KEY)

[[ $dokploy_key =~ ^[A-Za-z0-9_.:-]+$ ]] || die 'the Dokploy API key has characters a curl config cannot carry safely'
CURL_CFG=$(mktemp)
BODY=$(mktemp)
trap 'rm -f "$CURL_CFG" "$BODY"' EXIT
printf 'header = "x-api-key: %s"\n' "$dokploy_key" >"$CURL_CFG"
unset dokploy_key

# The server's message is printed on failure, never the request.
check_status() {
	[[ $2 == 2* ]] && {
		cat "$BODY"
		return 0
	}
	die "Dokploy $1: HTTP $2 $(jq -r '.message // empty' "$BODY" 2>/dev/null | cut -c1-200)"
}
get() {
	check_status "$1" "$(curl -K "$CURL_CFG" -sS -o "$BODY" -w '%{http_code}' "$DOKPLOY_URL/api/$1")"
}
post() {
	check_status "$1" "$(curl -K "$CURL_CFG" -sS -o "$BODY" -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data-binary @- "$DOKPLOY_URL/api/$1")"
}

echo 'Dokploy: finding the app'
projects=$(get project.all)
compose_id=$(jq -r --arg p "$PROJECT" --arg a "$APP" \
	'[.[] | select(.name == $p) | .environments[]?.compose[]? | select(.name == $a) | .composeId] | first // empty' <<<"$projects")
if [ -z "$compose_id" ]; then
	environment_id=$(jq -r --arg p "$PROJECT" '[.[] | select(.name == $p) | .environments[]?.environmentId] | first // empty' <<<"$projects")
	if [ -z "$environment_id" ]; then
		environment_id=$(jq -n --arg n "$PROJECT" '{name: $n, description: "Wealthfolio and wf-sync"}' | post project.create | jq -r '.environment.environmentId')
	fi
	compose_id=$(jq -n --arg n "$APP" --arg p "$PROJECT" --arg e "$environment_id" \
		'{name: $n, appName: $p, description: "Wealthfolio and wf-sync", environmentId: $e, composeType: "docker-compose", sourceType: "raw"}' |
		post compose.create | jq -r '.composeId')
	echo "  created $PROJECT/$APP"
fi
[ -n "$compose_id" ] && [ "$compose_id" != null ] || die 'no composeId from Dokploy'

echo 'Tailnet: checking the UI is published'
host=$(tailscale status --json | jq -r '.Self.DNSName | rtrimstr(".")')
origin="https://$host:$UI_PORT"
# Changing the serve config takes root or the Tailscale operator, and it survives restarts: a one-time step.
tailscale serve status --json | jq -e --arg web "$host:$UI_PORT" '.Web[$web].Handlers["/"].Proxy == "http://127.0.0.1:8088"' >/dev/null ||
	die "publish the UI once, then run this again: sudo tailscale serve --bg --https=$UI_PORT http://127.0.0.1:8088"

echo 'Env: building'
# A new salt on every run, so a rollout also recreates the wealthfolio container: seconds, and the sessions survive.
sync_image=$(awk '/ghcr.io\/alxwlw\/wf-sync/ { print $2; exit }' "$COMPOSE_FILE")
password_hash=$(printf '%s' "$wf_password" | docker run --rm -i --entrypoint bun "$sync_image" \
	-e 'console.log(await Bun.password.hash(await Bun.stdin.text(), { algorithm: "argon2id" }))' 2>/dev/null)
[[ $password_hash == \$argon2id\$* ]] || die 'hashing the password failed'
add_env WF_PASSWORD "$wf_password"
add_env WF_SECRET_KEY "$wf_secret_key"
add_env WF_AUTH_PASSWORD_HASH "$password_hash"
add_env WF_CORS_ALLOW_ORIGINS "$origin"
add_env TZ "$TIME_ZONE"
for name in "${CONNECTOR_VARS[@]}"; do
	value=$(op read "$OP_ITEM/$name" 2>/dev/null) || value=""
	[ -z "$value" ] || add_env "$name" "$value"
done
unset wf_password wf_secret_key password_hash value

echo 'Dokploy: writing compose, env and config.yaml'
jq -Rs --arg id "$compose_id" '{composeId: $id, composeFile: ., sourceType: "raw", composeType: "docker-compose"}' "$COMPOSE_FILE" |
	post compose.update >/dev/null
printf '%s' "$env_block" | jq -Rs --arg id "$compose_id" '{composeId: $id, env: .}' | post compose.saveEnvironment >/dev/null
stored=$(get "compose.one?composeId=$compose_id")
# Compare digests, so that neither value lands in a variable that outlives this check.
[ "$(jq -j '.env // ""' <<<"$stored" | sha256sum)" = "$(printf '%s' "$env_block" | sha256sum)" ] || die 'the env stored in Dokploy differs from what was sent; not deploying'
unset env_block
app_name=$(jq -r '.appName' <<<"$stored")
mount_id=$(jq -r '[(.mounts // [])[] | select(.type == "file" and .filePath == "config.yaml") | .mountId] | first // empty' <<<"$stored")
last_deployment=$(jq -r '(.deployments // []) | sort_by(.createdAt) | last // empty | .deploymentId' <<<"$stored")
unset stored
if [ -z "$mount_id" ]; then
	jq -Rs --arg id "$compose_id" '{type: "file", filePath: "config.yaml", mountPath: "/app/config.yaml", content: ., serviceId: $id, serviceType: "compose"}' "$CONFIG_FILE" |
		post mounts.create >/dev/null
else
	jq -Rs --arg id "$mount_id" '{mountId: $id, content: .}' "$CONFIG_FILE" | post mounts.update >/dev/null
fi

echo "Dokploy: deploying $app_name"
jq -n --arg id "$compose_id" '{composeId: $id}' | post compose.deploy >/dev/null
# compose.deploy only queues the deploy: wait for a deployment newer than the one seen above.
status=""
for _ in $(seq 1 100); do
	sleep 3
	latest=$(get "compose.one?composeId=$compose_id" | jq -r '(.deployments // []) | sort_by(.createdAt) | last // empty | "\(.deploymentId) \(.status)"')
	[ -n "$latest" ] && [ "${latest%% *}" != "$last_deployment" ] || continue
	status=${latest#* }
	[ "$status" = "done" ] || [ "$status" = "error" ] && break
done
[ "$status" = "done" ] || die "deployment status '${status:-none}': see the app's deployment log in Dokploy"

ui_up=""
for _ in $(seq 1 30); do
	curl -fsS -m 2 -o /dev/null http://127.0.0.1:8088/api/v1/auth/status && {
		ui_up=1
		break
	}
	sleep 2
done
[ -n "$ui_up" ] || die 'Wealthfolio did not answer on 127.0.0.1:8088'

# config.yaml is a single-file bind mount and is read once at startup, and a deploy that
# leaves the service unchanged doesn't recreate the container: only a restart applies it.
sync_container=$(docker ps -qf "label=com.docker.compose.project=$app_name" -f 'label=com.docker.compose.service=wf-sync')
[ -n "$sync_container" ] || die 'the wf-sync container is not running'
restarted=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker restart "$sync_container" >/dev/null

# A restart starts a pass by itself. Don't run `check` next to it: the two share the sources'
# rate limits and it fails on 429. A first Monobank import takes minutes, hence the long wait.
echo 'wf-sync: waiting for the first pass'
result=""
for _ in $(seq 1 120); do
	result=$(docker logs --since "$restarted" "$sync_container" 2>&1 | grep -F 'Done: ' | tail -1 || true)
	[ -n "$result" ] && break
	sleep 5
done
[ -n "$result" ] || die 'no finished pass after 10 minutes; see the logs of the wf-sync container'
echo "$result"
if docker logs --since "$restarted" "$sync_container" 2>&1 | grep -F ' ERROR '; then
	die 'a connector failed (see above); the app is deployed'
fi

echo
echo "Wealthfolio: $origin  (password: $OP_ITEM/WF_PASSWORD)"
echo "App: $app_name, data volume: ${app_name}_wealthfolio-data"
