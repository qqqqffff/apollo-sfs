# Keycloak Social IdP Setup

Configures Sign in with Apple and Sign in with Google on the `apollo-sfs-realm` realm. The mobile app's `/api/v1/mobile/auth/apple` and `/api/v1/mobile/auth/google` endpoints use Keycloak Token Exchange: the client presents an Apple/Google `id_token` and Keycloak returns a Keycloak `access_token` + `refresh_token`.

There are three concerns:

1. **Token exchange** — must be enabled on the realm before either IdP will work.
2. **Apple Identity Provider** — requires a Services ID, Key, and Team ID from Apple Developer.
3. **Google Identity Provider** — requires an OAuth 2.0 Client ID and secret from Google Cloud Console.

---

## Prerequisites

Authenticate against the master realm before running any `kcadm.sh` commands. `$KEYCLOAK_ADMIN` and `$KEYCLOAK_ADMIN_PASSWORD` are the values from your `.env`.

```bash
docker exec apollo-sfs-keycloak /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://localhost:8180 \
  --realm master \
  --user "$KEYCLOAK_ADMIN" \
  --password "$KEYCLOAK_ADMIN_PASSWORD"
```

---

## 1. Enable token exchange

Required for both Apple and Google. Keycloak 26+ exposes this as a realm attribute:

```bash
docker exec apollo-sfs-keycloak /opt/keycloak/bin/kcadm.sh update realms/apollo-sfs-realm \
  -s 'attributes.token-exchange-standard-flow-enabled=true'
```

> On Keycloak 21–25, token exchange requires a fine-grained authorization grant on the API client instead. See the [Keycloak docs](https://www.keycloak.org/docs/latest/securing_apps/#_token-exchange).

---

## 2. Apple Identity Provider

### Requirements

1. In **Apple Developer → Identifiers**, create a **Services ID** (e.g. `com.apollorowe.apollosfs.signin`).
2. Under the Services ID, enable **Sign In with Apple** and add the Keycloak redirect URI:
   ```
   https://apollo-sfs.com/realms/apollo-sfs-realm/broker/apple/endpoint
   ```
3. Create a **Key** with Sign In with Apple enabled. Download the `.p8` file and note the **Key ID**.
4. Note your 10-character **Team ID** from the Apple Developer account page.

### Commands

1. Create the Apple IdP (replace the placeholders before running):

```bash
APPLE_PRIVATE_KEY=$(grep -v 'BEGIN\|END' /path/to/AuthKey_XXXXXXXXXX.p8 | tr -d '\n')

docker exec apollo-sfs-keycloak /opt/keycloak/bin/kcadm.sh create identity-provider/instances \
  -r apollo-sfs-realm \
  -s alias=apple \
  -s providerId=apple \
  -s enabled=true \
  -s 'config.hideOnLoginPage=false' \
  -s 'config.clientId=com.apollosfs.app.signin' \
  -s 'config.teamId=<APPLE_TEAM_ID>' \
  -s 'config.keyId=<APPLE_KEY_ID>' \
  -s "config.privateKey=$APPLE_PRIVATE_KEY" \
  -s 'config.defaultScope=name email' \
  -s 'config.syncMode=FORCE'
```

2. Add claim mappers:

```bash
# email → user email attribute
docker exec apollo-sfs-keycloak /opt/keycloak/bin/kcadm.sh create \
  identity-provider/instances/apple/mappers \
  -r apollo-sfs-realm \
  -s name=apple-email \
  -s identityProviderMapper=oidc-user-attribute-idp-mapper \
  -s 'config.claim=email' \
  -s 'config.attribute=email' \
  -s 'config.syncMode=INHERIT'

# given_name → firstName (Apple only sends this on the very first sign-in)
docker exec apollo-sfs-keycloak /opt/keycloak/bin/kcadm.sh create \
  identity-provider/instances/apple/mappers \
  -r apollo-sfs-realm \
  -s name=apple-first-name \
  -s identityProviderMapper=oidc-user-attribute-idp-mapper \
  -s 'config.claim=given_name' \
  -s 'config.attribute=firstName' \
  -s 'config.syncMode=INHERIT'

# family_name → lastName
docker exec apollo-sfs-keycloak /opt/keycloak/bin/kcadm.sh create \
  identity-provider/instances/apple/mappers \
  -r apollo-sfs-realm \
  -s name=apple-last-name \
  -s identityProviderMapper=oidc-user-attribute-idp-mapper \
  -s 'config.claim=family_name' \
  -s 'config.attribute=lastName' \
  -s 'config.syncMode=INHERIT'

# Build stable username from provider alias + Apple subject claim
docker exec apollo-sfs-keycloak /opt/keycloak/bin/kcadm.sh create \
  identity-provider/instances/apple/mappers \
  -r apollo-sfs-realm \
  -s name=apple-username \
  -s identityProviderMapper=oidc-username-idp-mapper \
  -s 'config.template=${ALIAS}.${CLAIM.sub}' \
  -s 'config.syncMode=INHERIT'
```

---

## 3. Google Identity Provider

### Requirements

1. In **Google Cloud Console → APIs & Services → Credentials**, click **Create Credentials → OAuth 2.0 Client ID**.
2. Set the application type to **Web application**.
3. Add the Keycloak redirect URI under **Authorised redirect URIs**:
   ```
   https://apollo-sfs.com/realms/apollo-sfs-realm/broker/google/endpoint
   ```
4. Copy the **Client ID** and **Client Secret**.

### Commands

1. Create the Google IdP (replace the placeholders before running):

```bash
docker exec apollo-sfs-keycloak /opt/keycloak/bin/kcadm.sh create identity-provider/instances \
  -r apollo-sfs-realm \
  -s alias=google \
  -s providerId=google \
  -s enabled=true \
  -s 'config.hideOnLoginPage=false' \
  -s 'config.clientId=<GOOGLE_OIDC_CLIENT_ID>' \
  -s 'config.clientSecret=<GOOGLE_OIDC_CLIENT_SECRET>' \
  -s 'config.defaultScope=openid email profile' \
  -s 'config.syncMode=FORCE' \
  -s 'config.useJwksUrl=true'
```

2. Add claim mappers:

```bash
# email → user email attribute
docker exec apollo-sfs-keycloak /opt/keycloak/bin/kcadm.sh create \
  identity-provider/instances/google/mappers \
  -r apollo-sfs-realm \
  -s name=google-email \
  -s identityProviderMapper=oidc-user-attribute-idp-mapper \
  -s 'config.claim=email' \
  -s 'config.attribute=email' \
  -s 'config.syncMode=INHERIT'

# given_name → firstName
docker exec apollo-sfs-keycloak /opt/keycloak/bin/kcadm.sh create \
  identity-provider/instances/google/mappers \
  -r apollo-sfs-realm \
  -s name=google-first-name \
  -s identityProviderMapper=oidc-user-attribute-idp-mapper \
  -s 'config.claim=given_name' \
  -s 'config.attribute=firstName' \
  -s 'config.syncMode=INHERIT'

# family_name → lastName
docker exec apollo-sfs-keycloak /opt/keycloak/bin/kcadm.sh create \
  identity-provider/instances/google/mappers \
  -r apollo-sfs-realm \
  -s name=google-last-name \
  -s identityProviderMapper=oidc-user-attribute-idp-mapper \
  -s 'config.claim=family_name' \
  -s 'config.attribute=lastName' \
  -s 'config.syncMode=INHERIT'
```
