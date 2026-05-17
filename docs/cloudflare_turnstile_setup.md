# Cloudflare Turnstile Setup

Turnstile is Cloudflare's free, privacy-friendly CAPTCHA alternative used to protect the interest form from bots.

## 1. Create a Turnstile widget

1. Log in to the [Cloudflare dashboard](https://dash.cloudflare.com)
2. In the left sidebar, go to **Turnstile**
3. Click **Add widget**
4. Fill in the form:
   - **Widget name** — e.g. `Apollo SFS Interest Form`
   - **Hostname** — add the domain(s) where your app is hosted, e.g. `files.example.com`
   - **Widget type** — choose **Managed** (recommended; Cloudflare decides when to challenge)
5. Click **Create**

You will be shown a **Site Key** (public) and a **Secret Key** (private). Copy both.

## 2. Add the keys to your environment

In your `.env` file at the project root:

```env
CLOUDFLARE_TURNSTILE_SITE_KEY=0x4AAAAAAA...    # shown in the Cloudflare dashboard
CLOUDFLARE_TURNSTILE_SECRET_KEY=0x4AAAAAAA...  # keep this private — never commit it
```

Then restart the API container so it picks up the new variables:

```bash
docker compose restart api
```

## 3. Testing locally

Cloudflare provides special test keys that always pass or always fail without making real network calls:

| Site key | Secret key | Behaviour |
|---|---|---|
| `1x00000000000000000000AA` | `1x0000000000000000000000000000000AA` | Always passes |
| `2x00000000000000000000AB` | `2x0000000000000000000000000000000AB` | Always blocks |
| `3x00000000000000000000FF` | `3x0000000000000000000000000000000FF` | Forces a challenge |

Use the "always passes" keys in `.env` during local development so you can submit the form without a real Cloudflare challenge.

## 4. Allowed domains

The site key is domain-locked. If you access the app from a domain not listed in the widget settings, the widget will fail to load. Make sure to add:

- Your production domain (e.g. `files.example.com`)
- `localhost` for local development (if using the real keys)

Domains can be added or removed at any time from the Cloudflare dashboard without regenerating the keys.
