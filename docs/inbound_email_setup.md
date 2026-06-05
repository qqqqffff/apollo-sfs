# Inbound Email Setup (SendGrid Inbound Parse)

This feature lets any address at your domain — `support@apollo-sfs.com`, `billing@apollo-sfs.com`, etc. — receive mail that lands in the admin console's **Emails** tab. SendGrid receives the message on your MX records and POSTs the parsed contents to a webhook on the Pi; the API writes each message to disk and indexes it in Postgres for browsing.

The **local-part** of the recipient address becomes the *worker name*: mail to `support@…` shows up under the `support` mailbox, `billing@…` under `billing`, and so on. No per-address configuration is required — new mailboxes appear automatically the first time they receive mail.

### Data flow

```
sender → MX (mx.sendgrid.net) → SendGrid Inbound Parse
       → POST https://apollo-sfs.com/api/v1/webhooks/email-inbound
         → API writes  EMAIL_STORAGE_PATH/<worker>/<YYYY-MM>/<id>.json   (full message)
         → API inserts inbound_emails row                                (queryable index)
       → Admin UI  /admin/emails  reads the index + serves bodies from disk
```

The message JSON on disk holds the headers, text + HTML bodies, and base64-inlined attachments. Postgres only stores the index (sender, subject, worker, read flag, file path) so listing and unread counts stay fast.

---

## 1. Prerequisites

- Your domain's DNS is already managed in SendGrid (per the existing outbound relay setup) and you can edit **MX** records.
- SSH/admin access to the Pi running the Compose stack.
- An admin account in the app (the Emails tab is admin-only).

---

## 2. Configure SendGrid Inbound Parse

### 2a. Point MX at SendGrid

Inbound Parse requires the receiving (sub)domain's MX record to point at SendGrid. Add:

| Type | Host (name)        | Value            | Priority |
| ---- | ------------------ | ---------------- | -------- |
| MX   | `apollo-sfs.com`   | `mx.sendgrid.net`| `10`     |

> If `apollo-sfs.com` already has MX records for another mail provider, dedicate a subdomain instead (e.g. `inbound.apollo-sfs.com`) and use that everywhere below — addresses then look like `support@inbound.apollo-sfs.com`. Mixing providers on the same MX is not supported.

### 2b. Create the Inbound Parse host

1. In the SendGrid dashboard go to **Settings → Inbound Parse → Add Host & URL**.
2. **Receiving Domain** — `apollo-sfs.com` (or your dedicated subdomain).
3. **Destination URL** —
   ```
   https://apollo-sfs.com/api/v1/webhooks/email-inbound?token=<SENDGRID_WEBHOOK_SECRET>
   ```
   The `?token=` value must match the `SENDGRID_WEBHOOK_SECRET` you set in step 3. Inbound Parse has **no** request signing, so this shared secret is what keeps strangers from POSTing fake mail at the endpoint.
4. **Leave "POST the raw, full MIME message" UNCHECKED.** The API parses SendGrid's default multipart form (separate `to`/`from`/`subject`/`text`/`html` fields). Raw MIME is not parsed.
5. (Optional) enable **Check incoming emails for spam**.
6. Save.

---

## 3. Environment variables

Add to `.env` at the project root:

| Variable                  | Required | Example                       | Notes                                                                                          |
| ------------------------- | -------- | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `SENDGRID_WEBHOOK_SECRET` | strongly recommended | `<openssl rand -hex 24>` | Must equal the `?token=` value in the Inbound Parse URL. If empty, the webhook accepts any caller. |

`EMAIL_STORAGE_PATH` is already set to `/home/app/service-worker-email` inside the container by `docker-compose.yml` — you do not normally need to override it. It is the in-container path; the host directory is configured by the volume mount in the next step.

---

## 4. Create the storage directory

The API container bind-mounts the host directory `${HOME}/service-worker-email` to the in-container `EMAIL_STORAGE_PATH`. On the Pi (`apollo` user) that resolves to `/home/apollo/service-worker-email`.

```bash
mkdir -p ~/service-worker-email
```

The mount is declared in `docker-compose.yml` under the `api` service:

```yaml
    volumes:
      - ${HOME}/service-worker-email:/home/app/service-worker-email
```

> **Ownership note:** the `api` container runs as `root`, so message files land on the host owned by `root`. That's fine for the app (it serves them through the admin UI). To read them directly on the host use `sudo`. If you prefer non-root ownership, create the directory and chown it to the UID the container runs as before first launch.

---

## 5. Apply the schema to the live database

The table lives in the base schema at `db/23_inbound_emails.sql`. Base-schema files only run automatically on a **fresh** Postgres volume (first-boot `initdb`), so on an already-running database you must apply it once by hand — same pattern as `docs/postgres_table_update.md`:

```bash
docker exec -i apollo-sfs-postgresql-app psql \
  -U "$POSTGRES_APP_USER" \
  -d "$POSTGRES_APP_DB" \
  -f /docker-entrypoint-initdb.d/23_inbound_emails.sql
```

Verify the table exists:

```bash
docker exec -i apollo-sfs-postgresql-app psql \
  -U "$POSTGRES_APP_USER" -d "$POSTGRES_APP_DB" \
  -c '\d inbound_emails'
```

---

## 6. Rebuild and redeploy

The feature touches both the Go API and the React frontend, so rebuild both images:

```bash
docker compose build api frontend
docker compose up -d api frontend
```

Confirm the API logged the storage path on boot:

```bash
docker logs apollo-sfs-api 2>&1 | grep "inbound email"
# inbound email: storing messages under /home/app/service-worker-email
```

---

## 7. nginx

No nginx change is required. The webhook lives under `/api/v1/` and is already proxied to the API by the existing `location /api/` block in `nginx/conf.d/apollo-sfs.conf` (which permits bodies up to `500M` — comfortably above SendGrid's ~30 MB inbound limit). Cloudflare in front likewise passes `/api/` through.

---

## 8. Verification

1. Send a test email from any external account to `test@apollo-sfs.com`.
2. Within a few seconds confirm a file landed on disk:
   ```bash
   sudo find ~/service-worker-email -type f -name '*.json'
   # …/service-worker-email/test/2026-05/<uuid>.json
   ```
3. Confirm the index row:
   ```bash
   docker exec -i apollo-sfs-postgresql-app psql \
     -U "$POSTGRES_APP_USER" -d "$POSTGRES_APP_DB" \
     -c "SELECT worker_name, from_addr, subject, read FROM inbound_emails ORDER BY received_at DESC LIMIT 5;"
   ```
4. In the app, open **Admin → Emails**. The `test` mailbox should show an unread badge; click it, open the message, and confirm the body renders. Opening it clears the unread badge; **Delete** removes both the row and the file.

---

## 9. Troubleshooting

| Symptom | Likely cause / fix |
| ------- | ------------------ |
| SendGrid shows the POST as `401` | The `?token=` in the Inbound Parse URL doesn't match `SENDGRID_WEBHOOK_SECRET`. Update one to match and restart the API. |
| POST returns `404` | Wrong path — it must be exactly `/api/v1/webhooks/email-inbound`. |
| POST returns `500`, SendGrid retries | API-side failure (e.g. can't write to disk). Check `docker logs apollo-sfs-api` for `inbound email: store failed`. Usually a permissions problem on the mounted directory. |
| Mail never arrives | MX not propagated or pointing elsewhere. Check `dig MX apollo-sfs.com +short` returns `mx.sendgrid.net`. Allow time for DNS/TTL. |
| Message stored but mailbox name looks wrong | The worker name is the sanitized local-part (lower-cased, `+suffix` stripped). Addresses whose local-part contains characters outside `[a-z0-9._-]` are dropped with a `200` and logged as "unroutable recipient". |
| `relation "inbound_emails" does not exist` in API logs | Step 5 wasn't applied to the running database. Run the `psql -f …23_inbound_emails.sql` command. |

---

## Reference

- Schema: `db/23_inbound_emails.sql`
- Webhook + admin handlers: `api/routes/admin/email_inbound_webhook.go`, `api/routes/admin/inbound_emails.go`
- Storage/index service: `api/routes/services/email_inbound.go`
- Admin UI: `frontend/src/routes/_auth.admin/emails.tsx`
