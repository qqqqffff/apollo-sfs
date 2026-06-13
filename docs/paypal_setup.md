# PayPal + Premium Tier Setup

The premium tier unlocks the SFS S3-like API (see `docs/sfs_api.md`) for a recurring subscription processed through PayPal. This guide walks an operator through provisioning the PayPal application, configuring the Keycloak group that carries the premium realm role, and wiring the relevant environment variables.

There are three concerns:

1. **PayPal application** — sandbox first, live once it works end-to-end.
2. **Keycloak realm** — adds the `premium` group + role so the JWT carries the role on subsequent logins.
3. **Apple Pay domain verification** — only needed if you want the Apple Pay button to render in Safari on a registered merchant domain.

---

## 1. Create a PayPal application

1. Sign in to the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/applications/sandbox).
2. **Sandbox first**: under *Apps & Credentials → Sandbox*, click **Create App**.
   - **App name** — e.g. `Apollo SFS (sandbox)`.
   - **Sandbox business account** — use the default test business account.
   - **App type** — Merchant.
3. Open the app. Copy the **Client ID** and **Secret**.
4. Under *Features*, ensure the following are enabled:
   - **Accept payments**
   - **Apple Pay** (if you plan to offer it — see §3)
5. Repeat the same steps under *Live* once you have a verified PayPal business account.

The environment variable `PAYPAL_ENV` selects which set of credentials is used at runtime (`sandbox` or `live`). The API auto-routes calls to `https://api-m.sandbox.paypal.com` or `https://api-m.paypal.com` accordingly, and reads the matching `SANDBOX_PAYPAL_*` or `PAYPAL_*` credential variables.

---

## 2. Configure the webhook

The webhook is how PayPal asynchronously confirms captures and notifies us of refunds. The route is `POST /api/v1/payments/webhook` — unauthenticated by middleware; authenticity is enforced by PayPal's signature verification.

1. In the same PayPal app page, scroll to **Webhooks** and click **Add Webhook**.
2. **Webhook URL** — `https://files.example.com/api/v1/payments/webhook` (replace with your `APP_BASE_URL`).
3. Subscribe to at minimum these event types:
   - `PAYMENT.CAPTURE.COMPLETED`
   - `PAYMENT.CAPTURE.REFUNDED`
   - `PAYMENT.CAPTURE.REVERSED`
   - `PAYMENT.CAPTURE.DENIED`
4. Save. PayPal generates a **Webhook ID** — copy it. The API uses this with `verify-webhook-signature` to authenticate the webhook caller.

---

## 3. Apple Pay domain verification (optional)

To show the Apple Pay button in Safari you must prove that you control the domain hosting the checkout page.

1. In the PayPal Developer dashboard, under your app → *Settings* → *Apple Pay*, click **Register Domain**.
2. Enter your `APP_BASE_URL` host (e.g. `apollo-sfs.com`).
3. PayPal will issue a verification file. Save its contents.
4. Serve it at the well-known path the verification check expects:
   - Path: `https://apollo-sfs.com/.well-known/apple-developer-merchantid-domain-association`

### Hosting the verification file (nginx on the host, not Docker)

The site nginx config already has a `/.well-known/` location block that serves static files from `/etc/nginx/well-known/.well-known/`:

```nginx
location /.well-known/ {
    alias /etc/nginx/well-known/.well-known/;
    default_type application/json;
    ...
}
```

Drop the PayPal-issued file into that directory and reload nginx — no restart needed:

```bash
# Copy the file PayPal gave you
sudo cp apple-developer-merchantid-domain-association \
    /etc/nginx/well-known/.well-known/apple-developer-merchantid-domain-association

# Reload nginx config (graceful — no dropped connections)
sudo nginx -t && sudo systemctl reload nginx
```

If you manage the repo's `nginx/well-known/` directory as the authoritative source, add the file there instead and re-sync it to the server so it survives the next deploy:

```bash
# On your local machine — add to the repo
cp apple-developer-merchantid-domain-association \
    nginx/well-known/.well-known/apple-developer-merchantid-domain-association

# On the server — sync from repo after pulling
sudo cp nginx/well-known/.well-known/apple-developer-merchantid-domain-association \
    /etc/nginx/well-known/.well-known/
sudo nginx -t && sudo systemctl reload nginx
```

5. Click **Verify** in PayPal. Verification typically takes seconds.

If you skip this step, the card-payment button still works; only the Apple Pay tile fails to render in Safari.

---

## 4. Keycloak: bootstrap the `premium` realm role and group

The premium flag is the source of truth in **Keycloak** so it travels in the access token's `realm_access.roles` claim. The API mirrors the claim into `users.is_premium` on every authenticated request (`api/routes/middleware/auth.go:RequireAuth`).

Run the following `kcadm.sh` commands from the project root. `$KEYCLOAK_ADMIN` and `$KEYCLOAK_ADMIN_PASSWORD` are the values from your `.env`.

```bash
# 1. Authenticate against the master realm
docker exec apollo-sfs-keycloak /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://localhost:8180 \
  --realm master \
  --user "$KEYCLOAK_ADMIN" \
  --password "$KEYCLOAK_ADMIN_PASSWORD"

# 2. List existing realm roles (to check if "premium" already exists)
docker exec apollo-sfs-keycloak /opt/keycloak/bin/kcadm.sh get roles \
  -r apollo-sfs-realm \
  --fields name,description

# 3. Create the premium realm role (skip if it already appears above)
docker exec apollo-sfs-keycloak /opt/keycloak/bin/kcadm.sh create roles \
  -r apollo-sfs-realm \
  -s name=premium \
  -s 'description=Premium subscriber — unlocks the SFS S3-like programmatic API. Granted by adding the user to the "premium" realm group after a successful PayPal capture.' \
  -s composite=false \
  -s clientRole=false

# 4. Create the premium group
docker exec apollo-sfs-keycloak /opt/keycloak/bin/kcadm.sh create groups \
  -r apollo-sfs-realm \
  -s name=premium

# 5. Capture the new group's ID, then assign the premium role to it
GROUP_ID=$(docker exec apollo-sfs-keycloak /opt/keycloak/bin/kcadm.sh get groups \
  -r apollo-sfs-realm --fields id,name \
  | jq -r '.[] | select(.name=="premium") | .id')

docker exec apollo-sfs-keycloak /opt/keycloak/bin/kcadm.sh add-roles \
  -r apollo-sfs-realm \
  --gid "$GROUP_ID" \
  --rolename premium
```

The API's `apollo-sfs-api` confidential client already has the service account permissions required to manage group membership through the Admin REST API. No additional client setup is needed.

---

## 5. Environment variables

Add the following to `.env` at the project root.

The API reads `SANDBOX_PAYPAL_*` variables when `PAYPAL_ENV=sandbox` and `PAYPAL_*` (no prefix) when `PAYPAL_ENV=live`. Only the variables for the active environment need to be populated.

| Variable                         | Required | Example              | Notes                                                                 |
| -------------------------------- | -------- | -------------------- | --------------------------------------------------------------------- |
| `SFS_API_KEY_PEPPER`             | yes      | `<openssl rand -base64 48>` | ≥ 32 bytes. Mixed into argon2id over every API key secret.   |
| `PAYPAL_ENV`                     | yes      | `sandbox`            | `sandbox` or `live`. Controls which credential set is read.           |
| `SANDBOX_PAYPAL_CLIENT_ID`       | sandbox  | `AYNJ...`            | Client ID from the sandbox app page.                                  |
| `SANDBOX_PAYPAL_SECRET_KEY`      | sandbox  | `ELk...`             | Secret from the sandbox app page.                                     |
| `SANDBOX_PAYPAL_WEBHOOK_ID`      | sandbox  | `2N9...`             | Webhook ID from the sandbox app's Webhooks panel.                     |
| `PAYPAL_CLIENT_ID`               | live     | `AYNJ...`            | Client ID from the live app page.                                     |
| `PAYPAL_SECRET_KEY`              | live     | `ELk...`             | Secret from the live app page.                                        |
| `PAYPAL_WEBHOOK_ID`              | live     | `2N9...`             | Webhook ID from the live app's Webhooks panel.                        |
| `PREMIUM_TIER_PRICE_CENTS`       | no       | `100`                | Charge in minor units. Default `999`. Planned: `100` monthly / `1000` annual. |
| `PREMIUM_TIER_CURRENCY`          | no       | `USD`                | ISO 4217 currency code. Default `USD`.                                |

> **Planned subscription pricing**: premium will be offered as **$1.00/month** or **$10.00/year**. The current `PREMIUM_TIER_PRICE_CENTS` is a placeholder for the one-time flow; the subscription billing implementation will replace it with per-plan price variables.

Restart the API so it picks up the variables:

```bash
docker compose restart api
```

The `SFS_API_KEY_PEPPER` is **mandatory** even if you have no immediate plans to issue API keys — the service refuses to start without it because rotating it after-the-fact invalidates every issued key.

---

## 6. Sandbox testing

1. In the [PayPal Sandbox accounts page](https://developer.paypal.com/dashboard/accounts), find a personal test buyer. Note its email and password.
2. Open the app, sign in as a non-premium user, visit `/premium`, and click **Pay with card** (or Apple Pay).
3. PayPal redirects to the sandbox login. Sign in as the test buyer, approve.
4. You're redirected back to `/premium?status=approved&token=<order_id>`; the React Query mutation runs the capture, which flips the DB flag and routes you to `/settings/api-keys`.
5. Confirm in the Keycloak admin console that the user has been added to the `premium` group.
6. Optionally replay the webhook payload manually via curl to confirm idempotency — no second `payments` row, no second tier flip.

If something is broken on the webhook path, the PayPal *Webhook simulator* (under the app's Webhooks panel) is the fastest way to surface the failure mode.

---

## 7. Going live

When you're satisfied with sandbox behaviour:

1. Update `PAYPAL_ENV` to `live`.
2. Populate `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET_KEY`, and `PAYPAL_WEBHOOK_ID` with the values from the *Live* tab of the same app. The sandbox credentials remain in `.env` unchanged and are simply ignored.
3. Re-verify the Apple Pay domain if you changed hosts.
4. Restart the API: `docker compose restart api`.
5. Pay yourself $0.01 — easier to refund — to confirm the full flow.

Refunds processed in the PayPal dashboard send `PAYMENT.CAPTURE.REFUNDED` to the webhook, which flips the user's `is_premium` flag back to false, removes them from the Keycloak group, and bulk-revokes their API keys.
