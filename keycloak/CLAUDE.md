# Keycloak

Keycloak 26.0.7 is the OpenID Connect identity provider for Apollo SFS. It handles all authentication: password login, social login (Google, Apple, Microsoft), brute-force protection, token issuance, and user federation.

Keycloak runs as a Docker service on the manager node (standard tier) with its own dedicated PostgreSQL database (`db-keycloak`).

## Directory Structure

```
keycloak/
├── import/
│   └── realm.json          # Full realm export (import with --import-realm on first boot)
├── providers/
│   └── apple-identity-provider-*.jar   # Apple Sign In IdP extension
└── themes/
    └── apollo-sfs/          # Custom login page and email theme
        ├── login/           # Login/register/error page templates (FreeMarker)
        └── email/           # Email template overrides
```

## Realm Configuration (`import/realm.json`)

The realm export is the source of truth for all Keycloak configuration. Import it when standing up a new environment.

### Key Settings

| Setting | Value |
|---------|-------|
| Realm name | `apollo-sfs-realm` |
| Token lifespan | 1800 s (30 min) |
| Session timeout | 86400 s (24 h) |
| Brute-force protection | Enabled — 10 failures in 900 s → temporary lock |
| Password policy | Min 12 chars, 1 uppercase, 1 lowercase, 1 digit, 1 special char |

### OAuth Clients

| Client ID | Type | Used by |
|-----------|------|---------|
| `apollo-sfs-api` | Confidential | Go API — token introspection and admin operations |
| `apollo-sfs-web` | Public | Web frontend SPA |
| `apollo-sfs-mobile` | Public (PKCE required) | iOS and Android mobile apps |

The mobile client enforces PKCE (`S256`) and does not use a client secret. The web client's allowed redirect URIs are scoped to `https://apollo-sfs.com/*`.

### Realm Roles

| Role | Purpose |
|------|---------|
| `admin` | Access to the admin panel in the web frontend and admin API routes |
| `premium` | Access to premium-tier features and storage tier upgrades |

Assign roles via the Keycloak admin console or the Admin REST API.

### Identity Providers

**Apple (Sign in with Apple)**
- Extension: `apple-identity-provider-*.jar` in `keycloak/providers/`
- Services ID: `com.apollorowe.apollosfs.signin`
- Requires: Team ID, Key ID, and a `.p8` private key (configured in the realm or admin console)
- Handles IdP-initiated flow and maps Apple's `sub` claim to the Keycloak user

**Google**
- Built-in Keycloak social provider
- OAuth 2.0 Client ID and Secret from Google Cloud Console
- Redirect URI: `https://auth.apollo-sfs.com/realms/apollo-sfs-realm/broker/google/endpoint`
- Email is mapped to Keycloak's email attribute; first-time login creates a linked account

**Microsoft**
- Built-in Keycloak social provider (alias must be `microsoft`)
- Azure AD app registration (multitenant + personal accounts) — client ID and secret from the Azure Portal
- Redirect URI (Web platform): `https://auth.apollo-sfs.com/realms/apollo-sfs-realm/broker/microsoft/endpoint`
- Setup steps: `keycloak/KC_setup.md` §4 — done entirely via the admin console, no restart needed

### SMTP

Keycloak sends emails (verification, password reset) via the internal Postfix relay:

- Host: `postfix` (Docker service name)
- Port: `587`
- No authentication or TLS (internal Docker overlay network only)
- From address: `noreply@apollo-sfs.com`

Postfix relays outbound mail through SendGrid using `SENDGRID_SMTP_PASSWORD`.

## Custom Theme

`keycloak/themes/apollo-sfs/` overrides the default Keycloak login and email templates to match the Apollo SFS brand.

- **Login theme:** FreeMarker templates in `themes/apollo-sfs/login/` — login page, registration, password reset, error pages
- **Email theme:** HTML and text templates in `themes/apollo-sfs/email/` — verification emails, password reset links

After editing themes, restart or hot-reload Keycloak:

```bash
docker service update --force apollo-sfs_keycloak
```

In development with `docker-compose.yml`, theme changes take effect immediately if the `themes/` directory is bind-mounted (check `docker-compose.yml` volumes).

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `KEYCLOAK_ADMIN` | Admin console username |
| `KEYCLOAK_ADMIN_PASSWORD` | Admin console password |
| `KEYCLOAK_PUBLIC_URL` | External URL (e.g. `https://auth.apollo-sfs.com`) — used in OIDC discovery |
| `KEYCLOAK_PUBLIC_HOST` | Hostname only (e.g. `auth.apollo-sfs.com`) |
| `POSTGRES_KC_USER` / `_PASSWORD` / `_DB` | Keycloak database credentials |

## First-Boot Import

On a fresh environment the realm must be imported. The Docker entrypoint handles this automatically if `--import-realm` is set and the realm file is mounted. Check `docker-stack.yml` / `docker-compose.yml` for the entrypoint command and the realm volume mount.

If the realm already exists, Keycloak skips the import on restart (it does not overwrite existing realms).

## Admin Console Access

The admin console is not exposed publicly. Access it via SSH port-forward:

```bash
ssh -L 8180:localhost:8180 <manager-node>
# Then open http://localhost:8180/admin
```

## Updating the Realm Export

After making changes in the admin console, export the realm and commit the updated file:

```bash
docker exec <keycloak-container> \
  /opt/keycloak/bin/kc.sh export \
  --realm apollo-sfs-realm \
  --file /tmp/realm.json
docker cp <keycloak-container>:/tmp/realm.json keycloak/import/realm.json
```

## OIDC Discovery

The Go API and both frontends use OIDC discovery to find Keycloak's public keys and endpoints:

```
https://auth.apollo-sfs.com/realms/apollo-sfs-realm/.well-known/openid-configuration
```

The Go API calls this URL on startup (configured by `KEYCLOAK_PUBLIC_URL` + `KEYCLOAK_REALM`).

## Upgrading Keycloak

Keycloak 26+ uses a Quarkus-based distribution. Before upgrading:
1. Export the realm (see above)
2. Check Keycloak migration guides for breaking changes
3. Test the Apple IdP provider JAR for compatibility with the new version
4. Update the image tag in `docker-stack.yml` and `docker-compose.yml`
5. Redeploy and verify login flows for all three clients
