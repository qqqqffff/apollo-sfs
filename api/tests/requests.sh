#!/usr/bin/env bash
# Sample curl requests for manual API testing.
# Sessions are stored in cookies.txt — run login first, then subsequent
# requests automatically carry the HttpOnly session cookie.
#
# Usage:
#   chmod +x requests.sh
#   ./requests.sh           # runs the health check
#   BASE_URL=https://example.com ./requests.sh
#
# Variables — override via environment or edit defaults below.
BASE_URL="${BASE_URL:-http://localhost:8080}"
COOKIE_JAR="${COOKIE_JAR:-/tmp/apollo-sfs-cookies.txt}"

# ── Helpers ────────────────────────────────────────────────────────────────────

CURL="curl -s -b $COOKIE_JAR -c $COOKIE_JAR"

# ── Health ─────────────────────────────────────────────────────────────────────

# GET /api/v1/health
$CURL "$BASE_URL/api/v1/health"

# ── Auth ───────────────────────────────────────────────────────────────────────

# POST /api/v1/auth/login
# Sets the session cookie used by all protected endpoints below.
$CURL -X POST "$BASE_URL/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "hunter2"}'

# POST /api/v1/auth/register
# invite_token comes from GET /api/v1/invitations/:token (admin sends the link).
$CURL -X POST "$BASE_URL/api/v1/auth/register" \
  -H "Content-Type: application/json" \
  -d '{
    "username":     "alice",
    "email":        "alice@example.com",
    "password":     "hunter2!!",
    "invite_token": "REPLACE_WITH_INVITE_TOKEN"
  }'

# POST /api/v1/auth/logout  (requires active session)
$CURL -X POST "$BASE_URL/api/v1/auth/logout"

# POST /api/v1/auth/refresh
$CURL -X POST "$BASE_URL/api/v1/auth/refresh"

# POST /api/v1/auth/forgot_password
# Always returns 200 regardless of whether the email is registered.
$CURL -X POST "$BASE_URL/api/v1/auth/forgot_password" \
  -H "Content-Type: application/json" \
  -d '{"email": "alice@example.com"}'

# POST /api/v1/auth/reset_password
# token comes from the reset email link.
$CURL -X POST "$BASE_URL/api/v1/auth/reset_password" \
  -H "Content-Type: application/json" \
  -d '{"token": "REPLACE_WITH_RESET_TOKEN", "new_password": "newpassword!!"}'

# ── Invitations (public) ───────────────────────────────────────────────────────

# GET /api/v1/invitations/:token  — validates a token before showing the register form
$CURL "$BASE_URL/api/v1/invitations/REPLACE_WITH_INVITE_TOKEN"

# ── Me ─────────────────────────────────────────────────────────────────────────

# GET /api/v1/me
$CURL "$BASE_URL/api/v1/me"

# ── Folders ────────────────────────────────────────────────────────────────────

# GET /api/v1/folders  — root contents (top-level folders + root files)
$CURL "$BASE_URL/api/v1/folders"

# GET /api/v1/folders  — paginated
$CURL "$BASE_URL/api/v1/folders?folder_limit=20&file_limit=20&folder_cursor=CURSOR&file_cursor=CURSOR"

# POST /api/v1/folders  — create root-level folder
$CURL -X POST "$BASE_URL/api/v1/folders" \
  -H "Content-Type: application/json" \
  -d '{"name": "Documents"}'

# POST /api/v1/folders  — create nested folder
$CURL -X POST "$BASE_URL/api/v1/folders" \
  -H "Content-Type: application/json" \
  -d '{"name": "Work", "parent_id": "REPLACE_WITH_FOLDER_UUID"}'

# GET /api/v1/folders/:folder_id
$CURL "$BASE_URL/api/v1/folders/REPLACE_WITH_FOLDER_UUID"

# PATCH /api/v1/folders/:folder_id  — rename
$CURL -X PATCH "$BASE_URL/api/v1/folders/REPLACE_WITH_FOLDER_UUID" \
  -H "Content-Type: application/json" \
  -d '{"name": "Personal Documents"}'

# DELETE /api/v1/folders/:folder_id  — folder must be empty first
$CURL -X DELETE "$BASE_URL/api/v1/folders/REPLACE_WITH_FOLDER_UUID"

# ── Files ──────────────────────────────────────────────────────────────────────

# POST /api/v1/files/upload  — multipart upload
$CURL -X POST "$BASE_URL/api/v1/files/upload" \
  -F "file=@/path/to/local/file.pdf" \
  -F "folder_id=REPLACE_WITH_FOLDER_UUID" \
  -F "name=my-document.pdf"

# GET /api/v1/files/:file_id  — metadata only (no content)
$CURL "$BASE_URL/api/v1/files/REPLACE_WITH_FILE_UUID"

# GET /api/v1/files/:file_id/download  — decrypted binary (Content-Disposition: attachment)
$CURL -o downloaded_file "$BASE_URL/api/v1/files/REPLACE_WITH_FILE_UUID/download"

# GET /api/v1/files/:file_id/preview  — decrypted binary (Content-Disposition: inline)
$CURL "$BASE_URL/api/v1/files/REPLACE_WITH_FILE_UUID/preview"

# PATCH /api/v1/files/:file_id  — rename
$CURL -X PATCH "$BASE_URL/api/v1/files/REPLACE_WITH_FILE_UUID" \
  -H "Content-Type: application/json" \
  -d '{"name": "renamed-document.pdf"}'

# DELETE /api/v1/files/:file_id
$CURL -X DELETE "$BASE_URL/api/v1/files/REPLACE_WITH_FILE_UUID"

# ── Admin — requires admin Keycloak role ───────────────────────────────────────

# GET /api/v1/admin/users  — paginated user list
$CURL "$BASE_URL/api/v1/admin/users"
$CURL "$BASE_URL/api/v1/admin/users?limit=50&cursor=CURSOR"

# GET /api/v1/admin/users/:user_id
$CURL "$BASE_URL/api/v1/admin/users/alice"

# PATCH /api/v1/admin/users/:user_id/quota  — set quota (bytes)
$CURL -X PATCH "$BASE_URL/api/v1/admin/users/alice/quota" \
  -H "Content-Type: application/json" \
  -d '{"quota_bytes": 10737418240}'

# POST /api/v1/admin/invitations
$CURL -X POST "$BASE_URL/api/v1/admin/invitations" \
  -H "Content-Type: application/json" \
  -d '{"email": "bob@example.com"}'

# GET /api/v1/admin/invitations  — paginated invitation list
$CURL "$BASE_URL/api/v1/admin/invitations"
$CURL "$BASE_URL/api/v1/admin/invitations?limit=20&cursor=CURSOR"

# DELETE /api/v1/admin/invitations/:id  — revoke
$CURL -X DELETE "$BASE_URL/api/v1/admin/invitations/REPLACE_WITH_INVITATION_UUID"

# GET /api/v1/admin/system/metrics  — current snapshot
$CURL "$BASE_URL/api/v1/admin/system/metrics"

# GET /api/v1/admin/system/metrics/history
$CURL "$BASE_URL/api/v1/admin/system/metrics/history"

# GET /api/v1/admin/system/metrics/stream  — SSE stream (Ctrl-C to stop)
curl -s -b "$COOKIE_JAR" -N "$BASE_URL/api/v1/admin/system/metrics/stream"
