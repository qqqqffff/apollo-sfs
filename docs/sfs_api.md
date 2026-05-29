# SFS S3-like API

The SFS API gives premium subscribers programmatic, S3-style access to their existing apollo-sfs storage allocation. It uses the same encrypted MinIO backing, the same per-user drive routing, and the same row-level security as the web UI — the API is a different lens onto identical data.

Everything described here lives under `/api/v1/sfs/`. All endpoints are POST; all request and response bodies are JSON.

---

## Authentication

Every request must carry an API key in the `Authorization` header:

```
Authorization: Bearer sfs_<prefix>_<secret>
```

Keys are issued from `https://files.example.com/settings/api-keys` and shown exactly once. Lost the secret? Revoke the old key and issue a new one — the database only stores the argon2id hash.

Free-tier accounts can call the management endpoints to list zero keys but cannot issue them; SFS requests with no key, an unknown key, or a key whose owner is non-premium all return `401`.

---

## Scopes

Each key carries one or more `(operation, path_prefix)` scope rules. The operation is one of:

- `read` — covers `/get` and `/head` (and `/list` against the same prefix).
- `write` — covers `/put`.
- `delete` — covers `/delete` and the source half of `/move`.
- `list` — covers `/list` (a `read` scope on the same prefix also satisfies `list`).

The `path_prefix` is matched on directory boundaries: a scope on `photos/` covers `photos/cat.jpg` but not `photographer/headshot.jpg`. An empty prefix covers the whole bucket. A scope on `photos` (no trailing slash) covers exactly the object `photos` and anything under `photos/`.

A scope mismatch returns `403 scope_required` with the operation and key in the response body so the client can present a useful error.

---

## Buckets

The `:bucket_id` path parameter must equal the API key's owning username (the Keycloak subject UUID) or the literal alias `me`. Any other value returns `403`.

---

## Common metadata shape

Every endpoint that returns object metadata uses the same shape:

```json
{
  "key": "photos/2024/cat.jpg",
  "parent": "be8da95e-…",
  "created_at": "2025-05-21T14:02:11Z",
  "updated_at": "2025-05-21T14:02:11Z",
  "remaining_quota": 42949672960,
  "size": 184320,
  "content_type": "image/jpeg",
  "extension": "jpg"
}
```

- `parent` is the folder UUID or the literal string `"root"`.
- Times are UTC ISO-8601.
- `remaining_quota` is `storage_quota_bytes - storage_used_bytes`, never negative.

---

## Endpoints

### `POST /api/v1/sfs/buckets/me/put`

Returns a presigned URL the client uses to upload the actual bytes. The file does not yet exist in MinIO when this responds; the upload completes when the client POSTs the bytes to `upload_url`.

Request:
```json
{
  "key": "photos/2024/cat.jpg",
  "content_type": "image/jpeg",
  "size_bytes": 184320
}
```

Response:
```json
{
  "upload_url": "/api/v1/files/upload/p?token=…&name=cat.jpg",
  "expires_at": "2025-05-21T14:17:11Z",
  "metadata": { /* see above; size and content_type reflect the request */ }
}
```

To actually upload, the client POSTs a multipart form (`file=<bytes>`) to `upload_url` within `expires_at`.

Scope needed: `write` on `key`.

### `POST /api/v1/sfs/buckets/me/get`

Returns a presigned download URL for the existing object.

Request: `{ "key": "photos/2024/cat.jpg" }`

Response:
```json
{
  "download_url": "/api/v1/files/<file_id>/download/p?token=…",
  "expires_at": "2025-05-21T14:17:11Z",
  "metadata": { /* full metadata of the object */ }
}
```

Scope needed: `read` on `key`.

### `POST /api/v1/sfs/buckets/me/head`

Returns just the metadata — no presign. Useful for existence / mtime checks.

Request: `{ "key": "photos/2024/cat.jpg" }`

Response: `{ "metadata": { /* full metadata */ } }`

Scope needed: `read` on `key`.

### `POST /api/v1/sfs/buckets/me/delete`

Removes the object. Quota is reclaimed.

Request: `{ "key": "photos/2024/cat.jpg" }`

Response: `{ "metadata": { /* snapshot of the deleted object */ } }`

Scope needed: `delete` on `key`.

### `POST /api/v1/sfs/buckets/me/list`

Lists files under a prefix. Subfolders are not enumerated — list each level separately if you need a recursive walk.

Request:
```json
{
  "prefix": "photos/2024",
  "limit": 50,
  "continuation_token": null
}
```

Response:
```json
{
  "objects": [
    { /* metadata for each object */ }
  ],
  "next_continuation_token": "eyJvIjoxMDB9"
}
```

`limit` defaults to `50` and is capped at `200`. Pass `next_continuation_token` back in to fetch the next page; an empty/absent value means the list is exhausted.

Scope needed: `list` (or `read`) on `prefix`.

### `POST /api/v1/sfs/buckets/me/move`

Renames and / or moves an object. Both the source delete and the destination write are scope-checked. If the destination path involves new folders, they are auto-created inside the same transaction so a quota failure rolls them back.

Request:
```json
{ "key": "drafts/notes.md", "new_key": "archive/2024/notes.md" }
```

Response: `{ "metadata": { /* metadata reflecting the new path */ } }`

Scopes needed: `delete` on `key` **and** `write` on `new_key`.

---

## Error codes

| Status | When                                                                          |
| ------ | ----------------------------------------------------------------------------- |
| `200`  | Success. (`/put` returns the same 200 — the URL is the work product.)        |
| `400`  | Malformed key (leading `/`, `..`, control characters, > 32 deep, etc.)        |
| `401`  | Missing / unknown / revoked / expired key, or key's owner does not exist.     |
| `402`  | Key valid but the owning user is not premium and not admin.                   |
| `403`  | `bucket_id` mismatch, or scope rule does not cover the requested operation.   |
| `404`  | Object not found in the resolved path.                                        |
| `413`  | `size_bytes` would exceed quota.                                              |
| `500`  | Internal error (database, MinIO, presign service).                            |
| `503`  | API key service not configured (server-side; only seen during initial setup). |

The `403 scope_required` response includes additional fields so clients can show a useful message:

```json
{
  "error": "scope_required",
  "operation": "write",
  "object_key": "photos/2024/cat.jpg",
  "detail": "api key does not grant \"write\" on \"photos/2024/cat.jpg\""
}
```

---

## Rate limiting

SFS endpoints inherit the standard per-IP rate limit applied to every public route. There is no per-key limit in v1 — issue separate keys per consumer if you need per-consumer rate-limiting at the application layer.

---

## End-to-end example

A complete write → list → read → delete cycle using `curl`:

```bash
KEY="sfs_xxx_yyyyy"      # the raw key the UI showed you once
HOST="https://files.example.com"

# 1. Reserve an upload slot + get a presign.
read -r UPLOAD_URL <<< "$(curl -sX POST $HOST/api/v1/sfs/buckets/me/put \
  -H "Authorization: Bearer $KEY" \
  -d '{"key":"sample/hello.txt","content_type":"text/plain","size_bytes":12}' \
  | jq -r .upload_url)"

# 2. Send the bytes.
echo -n "hello world!" > /tmp/hello.txt
curl -sX POST "$HOST$UPLOAD_URL" -F "file=@/tmp/hello.txt"

# 3. List the folder we just wrote into.
curl -sX POST $HOST/api/v1/sfs/buckets/me/list \
  -H "Authorization: Bearer $KEY" \
  -d '{"prefix":"sample"}'

# 4. Pull it back down.
DL_URL=$(curl -sX POST $HOST/api/v1/sfs/buckets/me/get \
  -H "Authorization: Bearer $KEY" \
  -d '{"key":"sample/hello.txt"}' | jq -r .download_url)
curl -s "$HOST$DL_URL"

# 5. Clean up.
curl -sX POST $HOST/api/v1/sfs/buckets/me/delete \
  -H "Authorization: Bearer $KEY" \
  -d '{"key":"sample/hello.txt"}'
```

The same flow works against the sandbox PayPal-driven dev environment as long as your key was issued to a user who has at least one drive allocated and is in the `premium` group (or is an admin).
