# PayPal + Premium Tier Setup

The premium tier unlocks the SFS S3-like API (see `docs/sfs_api.md`) for a recurring subscription processed through PayPal (PayPal Subscriptions v1 — monthly or annual, auto-renewing). This guide walks an operator through provisioning the PayPal application and subscription plans, configuring the Keycloak group that carries the premium realm role, and wiring the relevant environment variables.

There are four concerns:

1. **PayPal application** — sandbox first, live once it works end-to-end.
2. **PayPal Product + Plans** — the monthly/annual billing plans subscriptions are created against.
3. **Keycloak realm** — adds the `premium` group + role so the JWT carries the role on subsequent logins.
4. **Apple Pay domain verification** — needed for the Apple Pay button on both storage add-ons and premium (see §5). Premium reaches card/Apple Pay/Google Pay through a second, self-billed subscription mode — see §9 for why PayPal-managed subscriptions can't use them.

---

## 1. Create a PayPal application

You need **two** PayPal applications from the start — there is no staged "sandbox first, flip a switch later" mode for the primary client; it is hardcoded to PayPal's live API. Testing happens exclusively through the second, sandbox-only app plus the admin-only "sandbox payments" toggle (Profile page).

1. Sign in to the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/applications/sandbox).
2. **Live/primary app**: under *Apps & Credentials → Live*, click **Create App** (requires a verified PayPal business account).
   - **App name** — e.g. `Apollo SFS`.
   - **App type** — Merchant.
3. **Sandbox app**: under *Apps & Credentials → Sandbox*, click **Create App**.
   - **App name** — e.g. `Apollo SFS (sandbox)`.
   - **Sandbox business account** — use the default test business account.
   - **App type** — Merchant.
4. Open each app. Copy its **Client ID** and **Secret**.
5. Under *Features* on both apps, ensure the following are enabled:
   - **Accept payments**
   - **Subscriptions**
   - **Apple Pay** (storage add-ons only — see §5)

The API always constructs **two** PayPal clients side by side, not one selected by a global switch:

- **Live/primary** — `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` / `PAYPAL_WEBHOOK_ID`, always at `https://api-m.paypal.com`. This is the client every non-admin user's payments go through, and the one admins use with the toggle below off. There is no environment variable that can route it to sandbox — that determination is never resolved from server config.
- **Sandbox-only** — `PAYPAL_SANDBOX_CLIENT_ID` / `PAYPAL_SANDBOX_CLIENT_SECRET` / `PAYPAL_SANDBOX_WEBHOOK_ID`, always at `https://api-m.sandbox.paypal.com`. This client only gets used for an admin whose own "sandbox payments" toggle (Profile page) is turned on for their current session — see `api/routes/services/paypal.go`'s `PayPalClients`. The toggle itself is validated server-side on every request against the caller's JWT `realm_access` roles (`middleware.SandboxEnabled`); it can't be spoofed by a client-supplied value. Leaving these three empty simply disables the toggle (admins get a 503 "payments not configured" if they turn it on anyway); it does not affect the live/primary client at all. This toggle is the *only* way any request is ever routed to sandbox, and the "Sandbox" badge shown across the app is purely a side effect of it.

Don't confuse this with the *old* `SANDBOX_PAYPAL_*` naming or the later `PAYPAL_ENV` variable from before the live/primary client was hardcoded — both are gone; the variable names below are current.

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

Apple Pay is used by both the **storage add-on** purchase flow and the **premium subscription** flow. The premium flow reaches it the long way round — see §7: a card or wallet cannot approve a PayPal-managed subscription at all, so those three funding sources open a subscription the API bills itself, whose first period is an ordinary Orders v2 purchase. Domain verification below is what makes the button appear in Safari for either.

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

### Why the web Apple Pay button can't be tested via the sandbox-payments toggle

PayPal issues a **different** domain-association file per environment, and each environment separately requires its own registered domain serving its own file at the same `/.well-known/` path — so one domain can only ever be verified with one PayPal app. `apollo-sfs.com` is (rightly) verified with the **live** app; the sandbox app therefore always reports this domain ineligible, and under the sandbox-payments toggle the Apple Pay tile simply stays hidden (the button's `config()` eligibility check fails silently). Hosting the sandbox file would require serving the checkout from a second, sandbox-registered domain — deliberately not done, to keep the deployment simple and avoid exposing a second app origin.

**Testing Apple Pay is therefore done against live:** buy the cheapest storage plan with a real card in Safari on the production site, then refund it (PayPal dashboard, or the admin orders page's refund/revert tooling). Everything *around* Apple Pay is still covered by the sandbox toggle — Google Pay (TEST), the PayPal wallet buttons, and hosted card fields all share the same order create/confirm/capture code paths the Apple Pay button drives.

Native iOS Apple Pay is unaffected by any of this: domain-association files only gate Apple Pay **on the web**. The app's PassKit flow tests against sandbox with a device signed into a sandbox iCloud account (with Apple's test cards in the Wallet) and the sandbox-payments toggle on.

### How the Apple Pay button is integrated (PayPal JS SDK v6)

The web Apple Pay button (`frontend/src/components/PayPalApplePayButton.tsx`) follows PayPal's current integration standard (<https://developer.paypal.com/apple-pay/integrate>), which differs from the legacy `paypal.com/sdk/js` integration the other buttons use:

1. **Browser-safe client token** — the SDK is initialised with a short-lived, domain-bound token instead of the client ID in the script URL. The API mints and caches it (`PayPalClient.BrowserSafeClientToken`, `POST /v1/oauth2/token` with `response_type=client_token`) and exposes it at:
   - `GET /api/v1/billing/client-token` (protected; honors the admin sandbox-payments toggle like `/billing/config`)
   - `GET /api/v1/config/paypal-client-token` (public, always live — for the interest page)
2. **Two SDK scripts**, loaded by the button component itself:
   - Apple's Apple Pay JS SDK (`https://applepay.cdn-apple.com/jsapi/v1/apple-pay-sdk.js`) — registers the official `<apple-pay-button>` element (allowed in the nginx CSP `script-src`).
   - PayPal Web SDK v6 core (`https://www.paypal.com/web-sdk/v6/core`, or `www.sandbox.paypal.com` under the sandbox toggle). The v6 core coexists with the legacy SDK by attaching as `window.paypal.v6` when the legacy SDK owns `window.paypal`.
3. **Flow** — `createInstance({ clientToken, components: ['applepay-payments'] })` → `createApplePayOneTimePaymentSession()` → eligibility via `.config()` → on tap, `new ApplePaySession(4, …)` → `validateMerchant` → create order server-side → `confirmOrder({ orderId, token })` → capture server-side → `completePayment`. The sheet only shows success after the capture returns, so the checkmark means the charge actually completed.

The iOS app mirrors the same semantics natively: `RNApplePay` (PassKit) resolves the tokenized payment while the sheet stays open, the app charges it through the API's direct-charge endpoints (Orders v2 with `payment_source.apple_pay`), then calls `completePayment(success)` so the sheet reflects the real outcome. Apple auto-fails the sheet if no result is delivered within ~30 seconds of authorization.

---

## 6. Environment variables

Add the following to `.env` at the project root, and to `docker-stack.yml`'s `api` service `environment:` block if you're adding a variable that isn't already forwarded there (Swarm services only see env vars explicitly listed in the stack file — sourcing `.env` alone is not enough).

| Variable                         | Required | Example              | Notes                                                                 |
| -------------------------------- | -------- | -------------------- | --------------------------------------------------------------------- |
| `SFS_API_KEY_PEPPER`             | yes      | `<openssl rand -base64 48>` | ≥ 32 bytes. Mixed into argon2id over every API key secret.   |
| `PAYPAL_CLIENT_ID`               | yes      | `AYNJ...`            | Client ID — live/primary app. Always used at PayPal's live API.        |
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
| `GOOGLE_PAY_SUBSCRIPTIONS_ENABLED` | no     | `true`               | **Leave off.** Needs PayPal to vault `payment_source.google_pay`, which it currently does not (§10) — turning it on charges then refunds the buyer. Google Pay is hidden on subscription checkouts while off; one-time purchases unaffected. Default off. |

Redeploy so the API picks up the variables (`docker-compose.yml`/`docker compose restart api` is deprecated for this project — see root `CLAUDE.md`):

```bash
./deploy.sh --deploy-only
```

The `SFS_API_KEY_PEPPER` is **mandatory** even if you have no immediate plans to issue API keys — the service refuses to start without it because rotating it after-the-fact invalidates every issued key.

---

## 7. Sandbox testing

There is no whole-app sandbox mode — the live/primary client is hardcoded to PayPal's live API from the moment `PAYPAL_CLIENT_ID`/`_SECRET` are populated. The only way to exercise the checkout flows against sandbox, at any point (before or after this deployment has real customers), is the per-admin "sandbox payments" toggle:

1. In the [PayPal Sandbox accounts page](https://developer.paypal.com/dashboard/accounts), find a personal test buyer. Note its email and password.
2. Sign in to Apollo SFS as an **admin** account, open the Profile page, and turn on **"Sandbox payments"**. Non-admin accounts have no way to reach sandbox — the badge and the sandbox client only ever appear as a side effect of this toggle, which is validated server-side against the caller's JWT admin role on every request.
3. Still on the Profile page, the premium card now shows the upgrade flow (admins with the toggle on and no active sandbox subscription see it same as a real user would); pick Monthly or Annual and click the PayPal subscribe button.
4. PayPal redirects to the sandbox login. Sign in as the test buyer, approve the subscription.
5. You're redirected back with `?status=approved&subscription_id=<id>`; the frontend calls `POST /payments/subscriptions/:id/confirm`, which flips the DB flag and routes you to `/settings/api-keys`.
6. Confirm in the Keycloak admin console that the user has been added to the `premium` group, and that a `premium_subscriptions` row exists with `status = 'active'`.
7. From the Profile page, confirm the premium card shows the Sandbox badge, a renewal date, and the next-payment line.
8. Test cancellation: click **Cancel Premium Membership** on the profile card, confirm, and verify the user's API keys and file-server links are revoked immediately and the `premium_subscriptions` row is `status = 'cancelled'`.
9. Optionally replay `BILLING.SUBSCRIPTION.ACTIVATED` manually via curl to confirm idempotency — no second grant, no duplicate audit log entry.

If something is broken on the webhook path, the PayPal *Webhook simulator* (under the app's Webhooks panel) is the fastest way to surface the failure mode — useful for `BILLING.SUBSCRIPTION.CANCELLED`/`.SUSPENDED`/`.EXPIRED` in particular, since those are otherwise slow to trigger organically in sandbox.

---

## 8. Going live

Since the live/primary client is always live, "going live" is just populating real credentials — there's no environment variable to flip:

1. Populate `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_WEBHOOK_ID` with the values from the *Live* tab of the app (§1).
2. Populate `PAYPAL_PLAN_ID_MONTHLY` / `PAYPAL_PLAN_ID_ANNUAL` with the Live Product/Plan ids from §2.
3. Re-verify the Apple Pay domain if you changed hosts (storage add-ons only — see §5).
4. Redeploy: `./deploy.sh --deploy-only`.
5. Subscribe yourself on the Monthly plan — easier to cancel/refund — to confirm the full flow, then cancel it from the Profile page. Non-admin real users will see the premium upgrade card automatically at this point (it's gated only on not already having an active membership, not on any environment flag).

You can keep exercising the checkout flows against sandbox at any time — as an admin, flip "sandbox payments" on in your Profile page for the current session (see §7). That requires `PAYPAL_SANDBOX_CLIENT_ID`/`_CLIENT_SECRET`/`_WEBHOOK_ID` **and** `PAYPAL_SANDBOX_PLAN_ID_MONTHLY`/`_ANNUAL` to be populated; it has no effect on, and needs nothing from, the live/primary client.

Subscription cancellations/suspensions/expirations processed on PayPal's side (dashboard or automatic dunning after failed renewal charges) arrive via `BILLING.SUBSCRIPTION.CANCELLED`/`.SUSPENDED`/`.EXPIRED`, which flip the user's `is_premium` flag back to false, remove them from the Keycloak group, and bulk-revoke their API keys and file-server links — the same effects as a user-initiated cancel from the Profile page.

---

## 9. Self-billed subscriptions (card, Apple Pay, Google Pay)

Everything above describes **PayPal-managed** subscriptions: the shopper approves on PayPal's hosted page and PayPal drives the recurring charges, notifying us by webhook. That path is PayPal-wallet-only, and not by choice.

### Why there are two billing modes

`POST /v1/billing/subscriptions` **silently ignores a `payment_source`**. It is not rejected, it is dropped — so there is no way to bind a card or a wallet to a PayPal-managed subscription. Verified against sandbox:

| Request | Result |
|---|---|
| `payment_source: {token: {id: "BOGUS", type: "PAYMENT_METHOD_TOKEN"}}` | `201 APPROVAL_PENDING` — accepted |
| `GET` that subscription afterwards | no `payment_source` in the response at all |
| `plan_id: "P-BOGUSPLANID"` (control) | `400 INVALID_PARAMETER_SYNTAX` |

The control matters: the endpoint *does* validate fields it knows, so a silent 201 on a bogus `payment_source` means the field isn't part of its schema. Don't spend time re-litigating this with vault tokens — the Vault v3 setup-token API (`/v3/vault/setup-tokens`, `/v3/vault/payment-tokens`) is also `403 NOT_AUTHORIZED` on both apps, since the "Save payment methods" capability isn't enabled.

So card, Apple Pay and Google Pay open a **self-billed** subscription instead (`premium_subscriptions.billing_mode = 'self'`), on rails Orders v2 does support and that the storage add-ons already use:

1. **First period** — an ordinary Orders v2 create+capture whose `payment_source.<src>` carries `attributes.vault.store_in_vault = ON_SUCCESS`. The capture response returns `attributes.vault.id`: the saved payment method. `POST /payments/subscriptions/wallet/order` then `/wallet/confirm`.
2. **Every period after** — `PaymentService.SubscriptionRenewalLoop` (hourly, started in `main.go`) charges that vault id with no shopper present, via `stored_credential {payment_initiator: MERCHANT, payment_type: RECURRING, usage: SUBSEQUENT, usage_pattern: SUBSCRIPTION_PREPAID}`. PayPal rejects the call outright without `payment_type`.

Vault-on-purchase works today even though the standalone Vault API doesn't — they're separately gated. Nothing needs enabling for this to run.

**We are the biller of record for these.** There is no PayPal dunning behind them; the retry policy in `payment.go` is the whole of it.

### What that means operationally

- **Renewal cadence** is `premium_subscriptions.next_charge_at`, ours alone. The hourly tick only bounds how *late* a renewal runs — a restart or downtime delays one, never skips it.
- **Failed renewals** retry after ~1 day, ~3 days, then ~5 days (`selfBilledMaxAttempts = 4` attempts total, the original included). After the last failure, premium is revoked and the subscription is cancelled — the same teardown as a user-initiated cancel. Access stays live during the retries.
- **Billing dates don't drift**: a renewal charged four days late still extends from the period that ended, not from the charge (`renewalPeriodStart`).
- **Cancellation** doesn't call PayPal — there's no subscription there to cancel. Clearing `next_charge_at` is what stops the billing. The saved payment method is *left in PayPal's vault*, because deleting it needs the Vault API that returns 403. It is never charged again. If you want cancelled cards actually purged, enable **Save payment methods** on both apps and wire `DELETE /v3/vault/payment-tokens/{id}` into the cancel path.
- **A capture with no vault id is refunded, not granted** — it would otherwise sell a subscription that silently dies at the end of period one. Same for a capture that loses the "one live subscription per user" race.
- **Webhooks don't drive these.** `paypal_subscription_id` is a synthetic `self:<uuid>` that no PayPal event can match. The renewal captures do emit `PAYMENT.CAPTURE.COMPLETED` like any other order.

### Sandbox testing

The §7 toggle covers this flow too, with one gap: **Apple Pay can't be tested in sandbox** (§5 — the domain is verified against the live app, so the tile stays hidden). Google Pay and hosted card fields both work under the toggle, and all three share the same create/confirm code path.

To exercise a renewal without waiting a month, set the row's `next_charge_at` into the past and wait for the next tick:

```sql
UPDATE premium_subscriptions SET next_charge_at = NOW() - INTERVAL '1 minute'
WHERE username = '<user>' AND billing_mode = 'self';
```

Then check `current_period_end` moved forward, `failed_charge_count` is 0, and a new capture exists in the sandbox dashboard. To exercise dunning, do the same after revoking the test card in the sandbox buyer account, and watch `failed_charge_count` climb and access drop on the fourth failure.

---

## 10. Wallet recurring-payment compliance (Apple Pay, Google Pay)

A self-billed subscription (§9) charges the saved payment method again every period with no shopper present. Both wallets have a **required, specified way** to disclose that up front, and taking a wallet payment with a plain one-time request and then billing it again is out of policy on both platforms. The terms are described once in `frontend/src/components/recurringTerms.ts` and each button translates them into its own dialect.

Neither failure mode is loud: the sheet renders, the payment succeeds, and the buyer simply never sees that they signed up for recurring billing. `frontend/src/__tests__/components/walletRecurring.test.ts` pins both request shapes for that reason.

### Apple Pay — `ApplePayRecurringPaymentRequest`

<https://developer.apple.com/documentation/applepayontheweb/applepayrecurringpaymentrequest>

Set as `recurringPaymentRequest` on the `ApplePayPaymentRequest`. Required members: `paymentDescription`, `regularBilling`, `managementURL`. We also send the optional `billingAgreement`; `trialBilling` is unused (no trials) and `tokenNotificationURL` is unused (see below).

`regularBilling` is an `ApplePayLineItem` with `paymentTiming: "recurring"`, `recurringPaymentStartDate`, `recurringPaymentIntervalUnit` (lowercase `month`/`year`) and `recurringPaymentIntervalCount`. No `recurringPaymentEndDate` — the subscription is open-ended until cancelled.

**Version gate:** `recurringPaymentRequest` was added in **Apple Pay on the Web version 14** (macOS 13 / iOS 16). One-time sheets still negotiate version 4 so older Safari keeps Apple Pay; a subscription sheet requires 14, and where `ApplePaySession.supportsVersion(14)` is false **the button hides** rather than falling back to a one-time sheet — the payment method would still be vaulted and billed later, which is exactly the undisclosed charge the requirement exists to prevent. PayPal, Google Pay and card remain available.

`managementURL` points at `/client/profile`, which is where cancellation lives. Keep that true — Apple surfaces it from Wallet, and it's also where Apple expects the buyer to be able to *update* the payment method.

**Not implemented:** `tokenNotificationURL` (Merchant Token Notification Services). Apple posts merchant-token life-cycle events there — card replaced, token deactivated. Without it, a subscription whose underlying card is reissued fails at renewal and falls into the §9 dunning cycle instead of being repaired silently. Adding it means standing up a public endpoint that validates Apple's notification signatures. Worth doing if Apple Pay becomes a common funding source for subscriptions.

### Google Pay — `recurringTransactionInfo`

<https://developers.google.com/pay/api/web/guides/resources/merchant-initiated-transactions>

`PaymentDataRequest` takes **exactly one** of `transactionInfo`, `recurringTransactionInfo`, `deferredTransactionInfo` or `automaticReloadTransactionInfo`. Subscription checkouts send `recurringTransactionInfo` with `label`, `managementUrl`, `billingAgreement` and a `recurrenceItems` array (`label`, `price`, `priceStatus`, `recurrencePeriod: { unit, count }` — unit **uppercase**, unlike Apple).

The code is written and tested, but **Google Pay is off for subscriptions by default and should stay off**, because of a PayPal-side blocker that is more fundamental than Google's own program gating.

#### Blocker 1 — PayPal does not vault `google_pay` (this is the real one)

Orders v2 **silently ignores** `payment_source.google_pay.attributes.vault`. Verified against sandbox with an invalid `store_in_vault` enum, which forces PayPal to reveal whether it parses the field at all:

| `payment_source` | invalid `store_in_vault` value | meaning |
|---|---|---|
| `card` | `400 INVALID_PARAMETER_VALUE` at `/payment_source/card/attributes/vault/store_in_vault` | parsed and validated |
| `apple_pay` | `400 INVALID_PARAMETER_VALUE` at `/payment_source/apple_pay/attributes/vault/store_in_vault` | parsed and validated |
| `google_pay` | **`201 Created`** | **not parsed — silently ignored** |

Corroborated by PayPal's own documentation set: there are "save payment method" guides for PayPal, cards and Apple Pay, and **none for Google Pay**.

Consequence: a Google Pay subscription would capture the first period, come back with **no vault id**, and have nothing to bill next month. The flow already fails safely — `ConfirmSelfBilledOrder` refunds any capture that returns no vault id and grants nothing (§9) — but the buyer would be charged and refunded for a subscription they never got. `GOOGLE_PAY_SUBSCRIPTIONS_ENABLED` is off precisely so that can't happen, and the API rejects `source=google_pay` on the self-billed endpoints while it's off, so a stale client can't trigger it either.

**This one is PayPal's to fix, not ours.** Ask PayPal support whether their Orders v2 integration supports vaulting `payment_source.google_pay` for merchant-initiated recurring charges. If they add it, re-run the probe above and expect a `400`.

#### Blocker 2 — Google's merchant-initiated transactions program

Separately, MIT is an opt-in Google program; a non-enrolled merchant has the request rejected. Note that **PayPal is the Google Pay merchant of record here** — `allowedPaymentMethods` and `merchantInfo` come from `paypal.Googlepay().config()`, with PayPal as the gateway — so enrolment is likely something PayPal holds, not something you can apply for directly. Confirm with PayPal before assuming you can enrol yourself.

#### Turning it on

Set `GOOGLE_PAY_SUBSCRIPTIONS_ENABLED=true` only once **both** are resolved. Until then Google Pay is hidden on subscription checkouts and completely unaffected on one-time purchases (storage add-ons and deposits keep working normally). Buyers who would have used Google Pay still have Apple Pay, PayPal and card.

### What is unaffected

One-time purchases — storage add-ons, expansion deposits, the account-request deposit — still send a plain `transactionInfo` / one-time `ApplePayPaymentRequest` and are untouched by any of this. The PayPal wallet button and hosted card fields carry their own disclosure (PayPal's approval page, and the copy under the card form respectively), so neither is affected by these gates.
