# Keycloak Social IdP Setup

Configures Sign in with Apple and Sign in with Google on the `apollo-sfs-realm` realm.

The **mobile app** authenticates via **identity-provider brokering**: it runs a browser-based OIDC Authorization Code + PKCE flow against Keycloak using the public `apollo-sfs-mobile` client with `kc_idp_hint=google`/`apple`, and Keycloak returns realm tokens directly. New users are invite-gated by the backend's `POST /api/v1/mobile/auth/session`. The mobile app no longer uses Token Exchange — the old `/api/v1/mobile/auth/{apple,google}` endpoints now return 410.

> The **web** app's Apple login still uses Keycloak Token Exchange (§1).

There are three concerns:

1. **Token exchange** — needed only for the *web* Apple login (§1); the mobile app does not use it.
2. **Apple Identity Provider** — requires a Services ID, Key, and Team ID from Apple Developer. Used by both mobile brokering and the web Token Exchange.
3. **Google Identity Provider** — requires an OAuth 2.0 Client ID and secret from Google Cloud Console.

> **Broker redirect host:** the Apple/Google "Return URL"s below were written for the original `apollo-sfs.com` deployment. Keycloak now has its own hostname (`auth.apollo-sfs.com`); use whichever broker host your working Google login uses, e.g. `https://auth.apollo-sfs.com/realms/apollo-sfs-realm/broker/<alias>/endpoint`.

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

## 1. Token exchange — no longer required

All social login (web and mobile, Google and Apple) now uses **identity-provider
brokering**: a standard OIDC Authorization Code flow against Keycloak with
`kc_idp_hint`. Token exchange is no longer used by any client, so `KC_FEATURES`
needs no `token-exchange`, and the `token-exchange-standard-flow-enabled` realm
attribute is not needed. The IdP setup below (§2–§3) is still required.

---

## 2. Apple Identity Provider

Apple is not a built-in Keycloak social provider. This setup uses the [apple-identity-provider-keycloak](https://github.com/klausbetz/apple-identity-provider-keycloak) extension, which handles Apple's JWT-based client secret automatically. It must be configured through the Keycloak admin console, not kcadm.

> **Keycloak must be reachable from the internet** for Apple's OAuth redirect to complete. The nginx config proxies `/realms/`, `/resources/`, and `/js/` to Keycloak on port 8180. The admin console (`/admin/`) is intentionally not exposed — access it via SSH tunnel.

### Requirements

1. Download the JAR matching your Keycloak version from the [releases page](https://github.com/klausbetz/apple-identity-provider-keycloak/releases) and place it in `keycloak/providers/`:
   ```bash
   curl -L -o keycloak/providers/apple-identity-provider-keycloak-<version>.jar \
     https://github.com/klausbetz/apple-identity-provider-keycloak/releases/download/<version>/apple-identity-provider-keycloak-<version>.jar
   ```
2. Restart Keycloak and reload nginx so both pick up the changes:
   ```bash
   docker compose restart keycloak
   sudo nginx -t && sudo systemctl reload nginx
   ```
3. In **Apple Developer → Identifiers**, create a **Services ID**: `com.apollorowe.apollosfs.signin`.
4. Under the Services ID, enable **Sign In with Apple** and add:
   - **Domain**: `apollo-sfs.com`
   - **Return URL**: `https://apollo-sfs.com/realms/apollo-sfs-realm/broker/apple/endpoint`
5. Create a **Key** with Sign In with Apple enabled. Download the `.p8` file and note the **Key ID** (`8QB482NU55`) and **Team ID** (`2R46Z987AY`).

### Admin console setup

Open `https://apollo-sfs.com/admin` in your browser, sign in, and navigate to:

**apollo-sfs-realm → Identity Providers → Add provider → Apple**

Fill in the fields:
| Field | Value |
|---|---|
| Client ID | `com.apollorowe.apollosfs.signin` |
| Team ID | `2R46Z987AY` |
| Key ID | `8QB482NU55` |
| Private Key | Contents of `AuthKey_8QB482NU55.p8` |

Save, then add claim mappers under the **Mappers** tab:

| Name | Mapper Type | Claim | User Attribute |
|---|---|---|---|
| `apple-email` | Attribute Importer | `email` | `email` |
| `apple-first-name` | Attribute Importer | `given_name` | `firstName` |
| `apple-last-name` | Attribute Importer | `family_name` | `lastName` |

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

---

## 4. Automatic account linking (skip the "link account" page + email)

By default, when a social login's email matches an existing account, Keycloak's
**first broker login** flow shows a "Confirm Link Existing Account" page and then
verifies ownership by emailing the user (or asking them to re-enter their
password). To link automatically instead, replace those steps with the
**Automatically set existing user** authenticator.

> Safe because Google and Apple both return verified emails. Only enable this for
> identity providers you trust to verify email ownership.

**a. Duplicate the flow.** Admin console → **Authentication → Flows** →
`first broker login` → **Duplicate** → name it `first broker login - auto link`.
Set the executions to:

```
first broker login - auto link
├── Review Profile                          DISABLED
└── User creation or linking                REQUIRED
    ├── Create User If Unique               ALTERNATIVE
    └── Handle Existing Account             ALTERNATIVE
        ├── Automatically set existing user REQUIRED   ← add this
        ├── Confirm link existing account   DISABLED
        └── Account verification options    DISABLED
```

> **Automatically set existing user** must live *inside* **Handle Existing
> Account** — placed at the root it errors with "no existing duplicated user in
> ClientSession".

**b. Bind it to each IdP.** Identity Providers → `google` / `apple` →
**Advanced** (or the provider settings):
- **First login flow** → `first broker login - auto link`
- **Trust email** → On
- **Sync mode** → Force

After this, a social login whose email matches an existing account links silently
and proceeds straight to the app — no confirmation page and no email.

---

## 5. Email (SMTP)

The realm sends mail through the internal `postfix` service (which relays onward to
SendGrid over TLS). Postfix presents a **self-signed certificate** on the Docker
network, so the realm SMTP config uses **StartTLS = off** — Keycloak has no
"trust all certs" option and would otherwise reject the self-signed cert, failing
every send (account-link verification, password reset, etc.). The API talks to the
same postfix with `InsecureSkipVerify` for the same reason. The Keycloak→postfix
hop is plaintext but stays inside the Docker bridge; the postfix→SendGrid hop is
TLS-authenticated, so mail still leaves the host encrypted.

Realm Settings → Email: `postfix:587`, From `noreply@apollo-sfs.com`, **Enable
StartTLS off**, Enable SSL off, Authentication off. Use **Test connection** to
verify. If it ever fails with "must issue STARTTLS first", postfix is mandating
TLS — either relax `smtpd_tls_security_level` to `may`, or add postfix's cert to
`KC_TRUSTSTORE_PATHS` and turn StartTLS back on.
