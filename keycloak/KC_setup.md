#!/bin/bash
# Keycloak setup script for the filestorage app
#
# Flow:
#   1. Waits for Keycloak to be healthy
#   2. Authenticates to master realm
#   3. Imports realm.json (creates realm, clients, roles, SMTP, token settings)
#   4. Assigns manage-users role to the admin service account client
#   5. Fetches and prints both client secrets for your .env file
#
# Prerequisites:
#   - Keycloak container is running and healthy
#   - realm.json is present at REALM_JSON_PATH on the HOST machine
#   - ADMIN_USER / ADMIN_PASS match KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD in docker-compose.yml
#
# Usage:
#   chmod +x keycloak-setup.sh
#   ./keycloak-setup.sh

set -e

CONTAINER="keycloak"
KCADM="docker exec -i $CONTAINER /opt/keycloak/bin/kcadm.sh"

# ── Configurable values — update to match your setup ─────────────────────────
REALM="filestorage"
ADMIN_USER="$KEYCLOAK_ADMIN"                 # Keycloak master realm admin username
ADMIN_PASS="$KEYCLOAK_ADMIN_PASSWORD"        # Must match KEYCLOAK_ADMIN_PASSWORD in compose
KC_URL="http://localhost:8180"              # Host-side port Keycloak is bound to
API_CLIENT_ID="filestorage-api"             # Must match clientId in realm.json
ADMIN_CLIENT_ID="filestorage-admin"         # Must match clientId in realm.json
REALM_JSON_PATH="./realm.json"              # Path to realm.json on the HOST
REALM_JSON_CONTAINER_PATH="/tmp/realm.json" # Where it gets copied inside the container
# ─────────────────────────────────────────────────────────────────────────────


# ── Helper: wait for Keycloak to be ready ────────────────────────────────────
wait_for_keycloak() {
  echo "==> Waiting for Keycloak to be ready..."
  local max_attempts=30
  local attempt=1
  until docker exec "$CONTAINER" curl -sf "$KC_URL/health/ready" > /dev/null 2>&1; do
    if [ $attempt -ge $max_attempts ]; then
      echo "ERROR: Keycloak did not become ready after ${max_attempts} attempts. Aborting."
      exit 1
    fi
    echo "    Not ready yet (attempt $attempt/$max_attempts) — retrying in 5s..."
    sleep 5
    attempt=$(( attempt + 1 ))
  done
  echo "    Keycloak is ready."
}


# ── Helper: get client UUID by clientId ──────────────────────────────────────
get_client_uuid() {
  local client_id="$1"
  $KCADM get clients -r "$REALM" --fields id,clientId \
    | grep -A1 "\"$client_id\"" \
    | grep '"id"' \
    | cut -d'"' -f4
}


# ── Step 1: Wait for Keycloak ─────────────────────────────────────────────────
wait_for_keycloak


# ── Step 2: Authenticate to master realm ─────────────────────────────────────
echo ""
echo "==> [1/4] Authenticating to Keycloak master realm..."
$KCADM config credentials \
  --server "$KC_URL" \
  --realm master \
  --user "$ADMIN_USER" \
  --password "$ADMIN_PASS"


# ── Step 3: Import realm.json ─────────────────────────────────────────────────
# realm.json should define:
#   - realm name, displayName, enabled
#   - bruteForceProtected, failureFactor, waitIncrementSeconds, maxFailureWaitSeconds
#   - ssoSessionIdleTimeout, ssoSessionMaxLifespan, accessTokenLifespan
#   - registrationAllowed: false, resetPasswordAllowed: true, verifyEmail: false
#   - smtpServer (host, port, from)
#   - clients array with both filestorage-api and filestorage-admin
#     with correct grant types and serviceAccountsEnabled settings
#
# NOTE: Client secrets are NOT preserved in realm.json exports — Keycloak
# regenerates them on import. This script fetches them after import (step 4).
#
# To re-run this script on an existing realm, either:
#   a) Delete the realm first: kcadm.sh delete realms/$REALM
#   b) Change --override to true below (merges — may leave stale config)

echo ""
echo "==> [2/4] Copying realm.json into container..."
if [ ! -f "$REALM_JSON_PATH" ]; then
  echo "ERROR: realm.json not found at $REALM_JSON_PATH"
  echo "       Update REALM_JSON_PATH at the top of this script."
  exit 1
fi
docker cp "$REALM_JSON_PATH" "$CONTAINER":"$REALM_JSON_CONTAINER_PATH"

echo "==> [2/4] Importing realm from $REALM_JSON_PATH..."
docker exec "$CONTAINER" /opt/keycloak/bin/kc.sh import \
  --file "$REALM_JSON_CONTAINER_PATH" \
  --override false

echo "    Realm '$REALM' imported successfully."


# ── Step 4: Assign manage-users role to admin service account ─────────────────
# Service account role assignments are not preserved in realm.json exports
# and must be re-applied post-import via kcadm.sh.
echo ""
echo "==> [3/4] Assigning manage-users role to service account: $ADMIN_CLIENT_ID..."

ADMIN_CLIENT_UUID=$(get_client_uuid "$ADMIN_CLIENT_ID")

if [ -z "$ADMIN_CLIENT_UUID" ]; then
  echo "ERROR: Could not find client '$ADMIN_CLIENT_ID' in realm '$REALM'."
  echo "       Ensure the clientId in realm.json matches ADMIN_CLIENT_ID in this script."
  exit 1
fi

$KCADM add-roles \
  -r "$REALM" \
  --uusername service-account-"$ADMIN_CLIENT_ID" \
  --cclientid realm-management \
  --rolename manage-users

echo "    manage-users role assigned."


# ── Step 5: Fetch and print client secrets ────────────────────────────────────
echo ""
echo "==> [4/4] Fetching client secrets..."

API_CLIENT_UUID=$(get_client_uuid "$API_CLIENT_ID")

if [ -z "$API_CLIENT_UUID" ]; then
  echo "ERROR: Could not find client '$API_CLIENT_ID' in realm '$REALM'."
  echo "       Ensure the clientId in realm.json matches API_CLIENT_ID in this script."
  exit 1
fi

API_SECRET=$($KCADM get clients/"$API_CLIENT_UUID"/client-secret \
  -r "$REALM" --fields value | grep '"value"' | cut -d'"' -f4)

ADMIN_SECRET=$($KCADM get clients/"$ADMIN_CLIENT_UUID"/client-secret \
  -r "$REALM" --fields value | grep '"value"' | cut -d'"' -f4)


# ── Cleanup ───────────────────────────────────────────────────────────────────
docker exec "$CONTAINER" rm -f "$REALM_JSON_CONTAINER_PATH"


# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo " Keycloak setup complete."
echo ""
echo " Realm '$REALM' imported from realm.json."
echo " manage-users role assigned to $ADMIN_CLIENT_ID service account."
echo ""
echo " Add these to your Go API .env file:"
echo ""
echo "   KEYCLOAK_URL=http://keycloak:8080"
echo "   KEYCLOAK_REALM=$REALM"
echo "   KEYCLOAK_CLIENT_ID=$API_CLIENT_ID"
echo "   KEYCLOAK_CLIENT_SECRET=$API_SECRET"
echo "   KEYCLOAK_ADMIN_CLIENT_ID=$ADMIN_CLIENT_ID"
echo "   KEYCLOAK_ADMIN_CLIENT_SECRET=$ADMIN_SECRET"
echo "============================================================"