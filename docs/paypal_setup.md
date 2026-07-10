# PayPal + Premium Tier Setup

The premium tier unlocks the SFS S3-like API (see `docs/sfs_api.md`) for a recurring subscription processed through PayPal (PayPal Subscriptions v1 — monthly or annual, auto-renewing). This guide walks an operator through provisioning the PayPal application and subscription plans, configuring the Keycloak group that carries the premium realm role, and wiring the relevant environment variables.

There are four concerns:

1. **PayPal application** — sandbox first, live once it works end-to-end.
2. **PayPal Product + Plans** — the monthly/annual billing plans subscriptions are created against.
3. **Keycloak realm** — adds the `premium` group + role so the JWT carries the role on subsequent logins.
4. **Apple Pay domain verification** — only needed for storage add-ons' Apple Pay button (see §5); premium subscriptions don't support it (see below).

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
   - **Subscriptions**
   - **Apple Pay** (storage add-ons only — see §5)
5. Repeat the same steps under *Live* once you have a verified PayPal business account.

The API always constructs **two** PayPal clients side by side, not one selected by a global switch:

- **Live/primary** — `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` / `PAYPAL_WEBHOOK_ID`, at the base URL selected by `PAYPAL_ENV` (`sandbox` or `live`). This is the client every non-admin user's payments go through, and the one admins use with the toggle below off.
- **Sandbox-only** — `PAYPAL_SANDBOX_CLIENT_ID` / `PAYPAL_SANDBOX_CLIENT_SECRET` / `PAYPAL_SANDBOX_WEBHOOK_ID`, always at `https://api-m.sandbox.paypal.com`. This client only gets used for an admin whose own "sandbox payments" toggle (Profile page) is turned on for their current session — see `api/routes/services/paypal.go`'s `PayPalClients`. Leaving these three empty simply disables the toggle (admins get a 503 "payments not configured" if they turn it on anyway); it does not affect the live/primary client at all.

Don't confuse this with the *old* `SANDBOX_PAYPAL_*` naming from before this dual-client toggle existed — that scheme (documented in older revisions of this file) had `PAYPAL_ENV` pick between two mutually-exclusive credential sets for the *whole app*. It's gone; the variable names below are current.

---

## 2. Create a Product and Plans for premium subscriptions

Premium subscriptions are created against a PayPal **Billing Plan**, which itself belongs to a **Product**. These are created once per app (sandbox and live are separate) via the dashboard — the API only ever references the resulting Plan IDs, it never creates Products/Plans at runtime.

1. In the same PayPal app's environment (Sandbox or Live), go to **Pay & Get Paid → Subscriptions** (or `developer.paypal.com` → *Subscriptions* under that business account).
2. **Create a Product**: name it e.g. `Apollo SFS Premium`, type *Service*, category *Software*.
3. **Create two Plans** under that Product:
   - **Monthly** — recurring $1.00 every 1 month, no trial, no setup fee.
   - **Annual** — recurring $10.00 every 1 year, no trial, no setup fee.
4. Copy each Plan's ID (`P-...`). Repeat for the Live business account once you're ready to go live — sandbox and live Products/Plans are entirely separate.
5. These IDs go into `PAYPAL_PLAN_ID_MONTHLY` / `PAYPAL_PLAN_ID_ANNUAL` (live) and `PAYPAL_SANDBOX_PLAN_ID_MONTHLY` / `PAYPAL_SANDBOX_PLAN_ID_ANNUAL` (sandbox) — see §6.

If you change a plan's price later, PayPal treats that as a new plan revision affecting only new subscriptions by default — existing subscribers keep their original price unless you explicitly reprice active subscriptions from the dashboard. Keep `PREMIUM_MONTHLY_PRICE_CENTS` / `PREMIUM_ANNUAL_PRICE_CENTS` (§6) in sync with whatever the Plan is actually configured to charge — the API doesn't read the price back from PayPal, it only echoes these env vars for display.

---

## 3. Configure the webhook

The webhook is how PayPal asynchronously confirms captures/subscription events. The route is `POST /api/v1/payments/webhook` — unauthenticated by middleware; authenticity is enforced by PayPal's signature verification. It's shared by the premium subscription flow and the one-time Orders v2 flow storage add-ons still use.

1. In the same PayPal app page, scroll to **Webhooks** and click **Add Webhook**.
2. **Webhook URL** — `https://files.example.com/api/v1/payments/webhook` (replace with your `APP_BASE_URL`).
3. Subscribe to at minimum these event types:
   - `BILLING.SUBSCRIPTION.ACTIVATED` (premium grant)
   - `PAYMENT.SALE.COMPLETED` (premium renewal charge)
   - `BILLING.SUBSCRIPTION.CANCELLED`
   - `BILLING.SUBSCRIPTION.SUSPENDED`
   - `BILLING.SUBSCRIPTION.EXPIRED`
   - `PAYMENT.CAPTURE.COMPLETED` (storage add-ons)
   - `PAYMENT.CAPTURE.REFUNDED` (storage add-ons)
   - `PAYMENT.CAPTURE.REVERSED` (storage add-ons)
   - `PAYMENT.CAPTURE.DENIED` (storage add-ons)
4. Save. PayPal generates a **Webhook ID** — copy it. The API uses this with `verify-webhook-signature` to authenticate the webhook caller.

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
  -s 'description=Premium subscriber — unlocks the SFS S3-like programmatic API. Granted by adding the user to the "premium" realm group after a PayPal subscription activates.' \
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

## 5. Apple Pay domain verification (storage add-ons only, optional)

Premium subscriptions checkout via PayPal's hosted subscription-approval page (PayPal balance, linked bank/cards, Venmo) — PayPal Subscriptions v1 doesn't support locking a subscription's approval to a specific funding source the way Orders v2 does, so there's no Apple Pay option on the premium checkout. Apple Pay is only available on the **storage add-on** purchase flow.

To show the Apple Pay button in Safari for storage add-ons you must prove that you control the domain hosting the checkout page.

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

If you skip this step, the card-payment button still works for storage add-ons; only the Apple Pay tile fails to render in Safari.

---

## 6. Environment variables

Add the following to `.env` at the project root, and to `docker-stack.yml`'s `api` service `environment:` block if you're adding a variable that isn't already forwarded there (Swarm services only see env vars explicitly listed in the stack file — sourcing `.env` alone is not enough).

| Variable                         | Required | Example              | Notes                                                                 |
| -------------------------------- | -------- | -------------------- | --------------------------------------------------------------------- |
| `SFS_API_KEY_PEPPER`             | yes      | `<openssl rand -base64 48>` | ≥ 32 bytes. Mixed into argon2id over every API key secret.   |
| `PAYPAL_ENV`                     | yes      | `sandbox`            | `sandbox` or `live`. Base URL for the live/primary client only.        |
| `PAYPAL_CLIENT_ID`               | yes      | `AYNJ...`            | Client ID — live/primary app.                                          |
| `PAYPAL_CLIENT_SECRET`           | yes      | `ELk...`             | Secret — live/primary app.                                             |
| `PAYPAL_WEBHOOK_ID`              | yes      | `2N9...`             | Webhook ID — live/primary app's Webhooks panel.                        |
| `PAYPAL_SANDBOX_CLIENT_ID`       | no       | `AYNJ...`            | Client ID — dedicated sandbox app, backs the admin profile toggle.     |
| `PAYPAL_SANDBOX_CLIENT_SECRET`   | no       | `ELk...`             | Secret — dedicated sandbox app.                                        |
| `PAYPAL_SANDBOX_WEBHOOK_ID`      | no       | `2N9...`             | Webhook ID — dedicated sandbox app's Webhooks panel.                   |
| `PAYPAL_PLAN_ID_MONTHLY`         | yes      | `P-5ML...`           | Live monthly Billing Plan id (§2).                                     |
| `PAYPAL_PLAN_ID_ANNUAL`          | yes      | `P-3RX...`           | Live annual Billing Plan id (§2).                                      |
| `PAYPAL_SANDBOX_PLAN_ID_MONTHLY` | no       | `P-5ML...`           | Sandbox monthly Billing Plan id — required for the sandbox toggle to work for premium. |
| `PAYPAL_SANDBOX_PLAN_ID_ANNUAL`  | no       | `P-3RX...`           | Sandbox annual Billing Plan id.                                        |
| `PREMIUM_MONTHLY_PRICE_CENTS`    | no       | `100`                | Display price only (§2) — must match the Monthly Plan's actual price. Default `100`. |
| `PREMIUM_ANNUAL_PRICE_CENTS`     | no       | `1000`               | Display price only (§2) — must match the Annual Plan's actual price. Default `1000`. |
| `PREMIUM_TIER_CURRENCY`          | no       | `USD`                | ISO 4217 currency code. Default `USD`.                                |

Redeploy so the API picks up the variables (`docker-compose.yml`/`docker compose restart api` is deprecated for this project — see root `CLAUDE.md`):

```bash
./deploy.sh --deploy-only
```

The `SFS_API_KEY_PEPPER` is **mandatory** even if you have no immediate plans to issue API keys — the service refuses to start without it because rotating it after-the-fact invalidates every issued key.

---

## 7. Sandbox testing

1. In the [PayPal Sandbox accounts page](https://developer.paypal.com/dashboard/accounts), find a personal test buyer. Note its email and password.
2. Open the app, sign in as a non-premium user, visit `/premium`, pick Monthly or Annual, and click the PayPal subscribe button.
3. PayPal redirects to the sandbox login. Sign in as the test buyer, approve the subscription.
4. You're redirected back to `/premium?status=approved&subscription_id=<id>`; the frontend calls `POST /payments/subscriptions/:id/confirm`, which flips the DB flag and routes you to `/settings/api-keys`.
5. Confirm in the Keycloak admin console that the user has been added to the `premium` group, and that a `premium_subscriptions` row exists with `status = 'active'`.
6. From the Profile page, confirm the premium card shows the Sandbox badge, a renewal date, and the next-payment line.
7. Test cancellation: click **Cancel Premium Membership** on the profile card, confirm, and verify the user's API keys and file-server links are revoked immediately and the `premium_subscriptions` row is `status = 'cancelled'`.
8. Optionally replay `BILLING.SUBSCRIPTION.ACTIVATED` manually via curl to confirm idempotency — no second grant, no duplicate audit log entry.

If something is broken on the webhook path, the PayPal *Webhook simulator* (under the app's Webhooks panel) is the fastest way to surface the failure mode — useful for `BILLING.SUBSCRIPTION.CANCELLED`/`.SUSPENDED`/`.EXPIRED` in particular, since those are otherwise slow to trigger organically in sandbox.

---

## 8. Going live

When you're satisfied with sandbox behaviour:

1. Update `PAYPAL_ENV` to `live`.
2. Populate `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_WEBHOOK_ID` with the values from the *Live* tab of the same app.
3. Populate `PAYPAL_PLAN_ID_MONTHLY` / `PAYPAL_PLAN_ID_ANNUAL` with the Live Product/Plan ids from §2.
4. Re-verify the Apple Pay domain if you changed hosts (storage add-ons only — see §5).
5. Redeploy: `./deploy.sh --deploy-only`.
6. Subscribe yourself on the Monthly plan — easier to cancel/refund — to confirm the full flow, then cancel it from the Profile page.

Once live, you can still exercise the checkout flows against sandbox at any time — as an admin, flip "sandbox payments" on in your Profile page for the current session instead of touching `PAYPAL_ENV` (see §1). That requires `PAYPAL_SANDBOX_CLIENT_ID`/`_CLIENT_SECRET`/`_WEBHOOK_ID` **and** `PAYPAL_SANDBOX_PLAN_ID_MONTHLY`/`_ANNUAL` to be populated, independent of whatever `PAYPAL_ENV` is set to.

Subscription cancellations/suspensions/expirations processed on PayPal's side (dashboard or automatic dunning after failed renewal charges) arrive via `BILLING.SUBSCRIPTION.CANCELLED`/`.SUSPENDED`/`.EXPIRED`, which flip the user's `is_premium` flag back to false, remove them from the Keycloak group, and bulk-revoke their API keys and file-server links — the same effects as a user-initiated cancel from the Profile page.
