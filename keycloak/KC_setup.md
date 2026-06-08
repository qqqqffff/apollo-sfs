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

# ── Social IdP credentials (optional — needed for step 5) ────────────────────
# Set these before running to configure Sign in with Apple and Sign in with Google.
# Leave unset to skip IdP configuration.
APPLE_SERVICES_ID="${APPLE_SERVICES_ID:-}"           # e.g. com.apollosfs.app.signin
APPLE_TEAM_ID="${APPLE_TEAM_ID:-}"                   # 10-char Apple Team ID
APPLE_KEY_ID="${APPLE_KEY_ID:-}"                     # Key ID from Apple Developer
APPLE_P8_PATH="${APPLE_P8_PATH:-}"                   # Path to downloaded .p8 private key
GOOGLE_OIDC_CLIENT_ID="${GOOGLE_OIDC_CLIENT_ID:-}"   # Web application OAuth2 Client ID
GOOGLE_OIDC_CLIENT_SECRET="${GOOGLE_OIDC_CLIENT_SECRET:-}" # OAuth2 Client Secret
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
echo "==> [4/5] Fetching client secrets..."

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


# ── Step 5: Social Identity Providers (Apple & Google) ───────────────────────
#
# The mobile app's /api/v1/mobile/auth/apple and /google endpoints rely on
# Keycloak Token Exchange: the client presents an Apple/Google id_token and
# Keycloak exchanges it for a Keycloak access_token + refresh_token.
#
# Prerequisites before running this step:
#   Apple:
#     1. In Apple Developer → Identifiers, create a Services ID
#        (e.g. com.apollosfs.app.signin) and add the Keycloak redirect URI:
#        https://<your-domain>/realms/filestorage/broker/apple/endpoint
#     2. Create a Key with Sign In with Apple enabled, download the .p8 file.
#   Google:
#     1. In Google Cloud Console → APIs & Services → Credentials, create an
#        OAuth 2.0 Client ID (type: Web application).
#     2. Add authorised redirect URI:
#        https://<your-domain>/realms/filestorage/broker/google/endpoint

configure_social_idps() {
  echo ""
  echo "==> [5/5] Configuring Social Identity Providers..."

  # ── Token Exchange ───────────────────────────────────────────────────────
  # Keycloak 26+ exposes token exchange as a realm attribute.
  # On Keycloak 21-25 you must grant the token-exchange permission via
  # fine-grained authorization on the API client instead — see:
  # https://www.keycloak.org/docs/latest/securing_apps/#_token-exchange
  echo "    Enabling token exchange on realm '$REALM'..."
  $KCADM update realms/"$REALM" \
    -s 'attributes.token-exchange-standard-flow-enabled=true' 2>/dev/null || true

  # ── Apple Identity Provider ──────────────────────────────────────────────
  if [ -n "$APPLE_SERVICES_ID" ] && [ -n "$APPLE_TEAM_ID" ] && \
     [ -n "$APPLE_KEY_ID" ]       && [ -f "$APPLE_P8_PATH" ]; then

    echo "    Creating Apple Identity Provider (alias: apple)..."

    # Strip PEM header/footer and newlines to get the bare base64 key
    APPLE_PRIVATE_KEY=$(grep -v 'BEGIN\|END' "$APPLE_P8_PATH" | tr -d '\n')

    $KCADM create identity-provider/instances \
      -r "$REALM" \
      -s alias=apple \
      -s providerId=apple \
      -s enabled=true \
      -s 'config.hideOnLoginPage=false' \
      -s "config.clientId=$APPLE_SERVICES_ID" \
      -s "config.teamId=$APPLE_TEAM_ID" \
      -s "config.keyId=$APPLE_KEY_ID" \
      -s "config.privateKey=$APPLE_PRIVATE_KEY" \
      -s 'config.defaultScope=name email' \
      -s 'config.syncMode=FORCE'

    # Map email claim → user email attribute
    $KCADM create identity-provider/instances/apple/mappers \
      -r "$REALM" \
      -s name=apple-email \
      -s identityProviderMapper=oidc-user-attribute-idp-mapper \
      -s 'config.claim=email' \
      -s 'config.attribute=email' \
      -s 'config.syncMode=INHERIT'

    # Map given_name → firstName (only present on first Apple sign-in)
    $KCADM create identity-provider/instances/apple/mappers \
      -r "$REALM" \
      -s name=apple-first-name \
      -s identityProviderMapper=oidc-user-attribute-idp-mapper \
      -s 'config.claim=given_name' \
      -s 'config.attribute=firstName' \
      -s 'config.syncMode=INHERIT'

    # Map family_name → lastName
    $KCADM create identity-provider/instances/apple/mappers \
      -r "$REALM" \
      -s name=apple-last-name \
      -s identityProviderMapper=oidc-user-attribute-idp-mapper \
      -s 'config.claim=family_name' \
      -s 'config.attribute=lastName' \
      -s 'config.syncMode=INHERIT'

    # Build a stable username from provider alias + Apple subject
    $KCADM create identity-provider/instances/apple/mappers \
      -r "$REALM" \
      -s name=apple-username \
      -s identityProviderMapper=oidc-username-idp-mapper \
      -s 'config.template=${ALIAS}.${CLAIM.sub}' \
      -s 'config.syncMode=INHERIT'

    echo "    Apple IdP configured."
  else
    echo "    Skipping Apple IdP — set APPLE_SERVICES_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_P8_PATH."
  fi

  # ── Google Identity Provider ─────────────────────────────────────────────
  if [ -n "$GOOGLE_OIDC_CLIENT_ID" ] && [ -n "$GOOGLE_OIDC_CLIENT_SECRET" ]; then

    echo "    Creating Google Identity Provider (alias: google)..."

    $KCADM create identity-provider/instances \
      -r "$REALM" \
      -s alias=google \
      -s providerId=google \
      -s enabled=true \
      -s 'config.hideOnLoginPage=false' \
      -s "config.clientId=$GOOGLE_OIDC_CLIENT_ID" \
      -s "config.clientSecret=$GOOGLE_OIDC_CLIENT_SECRET" \
      -s 'config.defaultScope=openid email profile' \
      -s 'config.syncMode=FORCE' \
      -s 'config.useJwksUrl=true'

    # Map email claim → user email
    $KCADM create identity-provider/instances/google/mappers \
      -r "$REALM" \
      -s name=google-email \
      -s identityProviderMapper=oidc-user-attribute-idp-mapper \
      -s 'config.claim=email' \
      -s 'config.attribute=email' \
      -s 'config.syncMode=INHERIT'

    # Map given_name → firstName
    $KCADM create identity-provider/instances/google/mappers \
      -r "$REALM" \
      -s name=google-first-name \
      -s identityProviderMapper=oidc-user-attribute-idp-mapper \
      -s 'config.claim=given_name' \
      -s 'config.attribute=firstName' \
      -s 'config.syncMode=INHERIT'

    # Map family_name → lastName
    $KCADM create identity-provider/instances/google/mappers \
      -r "$REALM" \
      -s name=google-last-name \
      -s identityProviderMapper=oidc-user-attribute-idp-mapper \
      -s 'config.claim=family_name' \
      -s 'config.attribute=lastName' \
      -s 'config.syncMode=INHERIT'

    echo "    Google IdP configured."
  else
    echo "    Skipping Google IdP — set GOOGLE_OIDC_CLIENT_ID and GOOGLE_OIDC_CLIENT_SECRET."
  fi
}

configure_social_idps
