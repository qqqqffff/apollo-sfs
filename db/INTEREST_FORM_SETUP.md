# Interest Form — Database Setup

Run `14_interest_form.sql` against the live database to create the two new tables required by the interest form feature.

## Steps

1. Connect to the database container:

```bash
docker exec -it db-app psql -U <POSTGRES_APP_USER> -d <POSTGRES_APP_DB>
```

Or from the host (if the port is exposed):

```bash
psql -h localhost -U <POSTGRES_APP_USER> -d <POSTGRES_APP_DB>
```

2. Run the migration:

```bash
psql -h localhost -U <POSTGRES_APP_USER> -d <POSTGRES_APP_DB> \
     -f db/14_interest_form.sql
```

Or inside the `psql` prompt:

```sql
\i db/14_interest_form.sql
```

## Tables Created

### `interest_submissions`

Stores each interest form submission. Duplicate emails are accepted at the DB level but silently de-duped at the application layer so the frontend always sees a success response.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Primary key |
| `name` | TEXT | Submitter's display name |
| `email` | TEXT | Contact email (lowercased by backend) |
| `desired_storage_gb` | INT | Requested storage in GB (from slider) |
| `use_case` | TEXT | Free-text reason / use case |
| `ip_address` | TEXT | Originating IP (used for per-IP rate limit) |
| `created_at` | TIMESTAMPTZ | Submission time |
| `provisioned_at` | TIMESTAMPTZ | Set when an admin provisions an account |
| `invitation_id` | UUID FK | Links to `invitations.id` after provisioning |

### `interest_form_settings`

Single-row settings table. The daily cap is configurable from the admin panel without a redeploy.

| Column | Type | Description |
|---|---|---|
| `id` | INT | Always `1` (single-row constraint) |
| `daily_cap` | INT | Max submissions accepted per calendar day (UTC) |
| `updated_at` | TIMESTAMPTZ | Last time settings were changed |

## Environment Variables Required

Add the following to your `.env` file before restarting the API:

```env
# Cloudflare Turnstile — get keys at https://dash.cloudflare.com/?to=/:account/turnstile
CLOUDFLARE_TURNSTILE_SECRET_KEY=<your-secret-key>
CLOUDFLARE_TURNSTILE_SITE_KEY=<your-site-key>
```
