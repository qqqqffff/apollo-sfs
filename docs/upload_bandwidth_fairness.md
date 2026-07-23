# Fair Per-User Upload Bandwidth Cap

Nothing in Apollo SFS deliberately limited upload throughput until this
feature — a ~5MB/s ceiling users saw on large uploads was an accidental
side effect of the frontend sending one 5MB chunk at a time and waiting for
each round trip before starting the next (fixed separately: chunks now
upload through a small worker pool, see `frontend/src/hooks/useFileUpload.ts`).
Once that accidental bottleneck is gone, a single user's upload can otherwise
saturate the server's entire inbound connection, starving everyone else (API
requests included). This feature replaces the accident with a deliberate,
self-calibrating policy — no manually configured Mbps number to keep in sync
with your actual connection.

## The policy

The budget is derived automatically from the server's own periodic WAN speed
test (`routes/admin/speedtest.go`, probes `speed.cloudflare.com` every 30
minutes, same one the admin metrics page and alarm system already use) rather
than an env var:

```
reserve  = min(100 Mbps, 15% of measured speed)
budget   = measured speed − reserve
per-user = budget ÷ (number of users currently mid-upload)
```

The reserve is held back, unthrottled, for the rest of the API — auth,
listings, downloads, WebSocket metrics, etc. — so uploads can never choke out
everything else even while multiple users saturate their upload share. It
scales with the link: capped at 100 Mbps flat on fast connections (so a
multi-gigabit line doesn't reserve an unreasonably large slice), but only 15%
on slower ones (so a modest connection isn't left with too little upload
budget).

The remaining budget is split **evenly, live, across however many distinct
users currently have an upload request in flight**:

- One user uploading alone gets the *entire* net budget.
- A second user starting a concurrent upload immediately halves both users'
  caps.
- When one of them finishes, the survivor's cap goes back up.

This is recomputed on every upload request starting or finishing, and again
whenever a fresh speed measurement lands — there's no static per-user number;
"equitable" here means *equal share of whatever the link can currently
support, updated in real time*.

**No cap is applied until a clean speed measurement exists** (see below) —
fresh installs or a stretch of constant upload activity simply run
unthrottled rather than guessing at a number, same as before this feature
existed.

## Avoiding a feedback loop: "clean" samples only

The obvious trap: if the speed test runs while a real upload is saturating
the link, it reads *lower* than the link's actual capacity — because the
upload competed with the probe for the same bandwidth — and a budget computed
from that reading would be too conservative, potentially compounding downward
on every subsequent test.

To prevent this, a speed test result is only trusted to feed the budget when
**zero uploads were active both immediately before and immediately after the
probe ran** (`Handler.activeUploadCount`, backed by
`BandwidthManager.ActiveUsers`). `Handler.runAndRecordSpeedTest` checks this
around every probe — scheduled (`SpeedTestLoop`, every 30 min) or manually
triggered from the admin page — and only then updates the cache
`CleanNetworkSpeedMbps` (implementing `services.NetworkSpeedSource`) reads
from. A probe that overlapped an upload still updates the existing
display/alarm-facing result as before; it's excluded only from the value that
feeds the upload cap.

Practically: if uploads are running near-continuously, the budget keeps using
the last known-clean measurement (however old) rather than drifting toward a
skewed one — and on a server with occasional idle stretches, a clean sample
naturally lands within 30 minutes.

### Hard cap: a server that's never idle

A server with genuinely constant upload traffic could go without a clean
sample forever under the rule above. `recordSpeedTestSample`
(`routes/admin/speedtest.go`) caps how long that's allowed: it tracks a
streak of consecutive unclean-or-failed probes, and once that streak reaches
`maxConsecutiveUncleanSpeedTests` (**48** — about 24h at the 30-minute loop
cadence) it forces a promotion regardless, in two tiers:

1. **Least-dirty candidate.** Across the streak, the successful (non-error)
   probe that had the *fewest* concurrent uploads around it (`dirtiness =
   max(uploads active at probe start, uploads active at probe end)`) is
   tracked as a fallback candidate. If one exists when the hard cap is hit,
   it's promoted — the closest thing to a clean reading the window actually
   produced, even if not perfectly clean.
2. **Flat assumed budget.** If *no* probe in the entire streak succeeded
   (every attempt errored — e.g. no outbound internet), there's no candidate
   to fall back to, so a synthetic `fallbackBudgetMbps` reading (**900
   Mbps**) is used instead, so the cap has something to work with rather than
   staying unbounded on a server whose speed test can't run at all.

Either fallback promotion sets `SpeedTestResult.FallbackReason` (surfaced in
`GET /admin/system/speed-test`'s JSON) and is logged
(`upload bandwidth budget: ...`), so it's visible in the admin UI and logs
that the current budget came from a fallback rather than a genuinely clean
measurement. The streak resets on *any* promotion — clean or fallback — so
the 48-probe clock restarts from zero each time.

## Implementation

`services.BandwidthManager` (`api/routes/services/bandwidth.go`) tracks one
`golang.org/x/time/rate.Limiter` per active user (keyed by user ID — the
Keycloak `sub`, same identity used everywhere else in the API):

- `Acquire(userID)` marks a user active, returns their limiter, and recomputes
  every active user's `Limit`/`Burst` from the current clean speed reading
  (via `SetSpeedSource`'s `NetworkSpeedSource`). It returns a `release` func
  the caller must invoke once the request's upload bytes have been read;
  `release` decrements a per-user refcount (so a user's several concurrent
  chunk requests count as one user, not several) and, once that user has no
  more in-flight requests, drops them from the split and rebalances everyone
  else.
- No speed source configured, or the source reporting no clean sample yet
  (`ok == false`), sets every active limiter's rate to `rate.Inf` —
  unthrottled — rather than falling back to some default number.
- A floor (`minBandwidthBurstBytes`, 256 KiB) keeps every user's token-bucket
  burst large enough that a single `Read()` from the multipart body parser
  never exceeds it — otherwise `rate.Limiter.WaitN` would error out instead of
  throttling once enough users are active to shrink a fair share below a
  typical read-buffer size.
- `throttledBody` wraps `http.Request.Body` so each `Read()` is paced by the
  caller's limiter *before* returning bytes. Slowing down how fast the server
  reads from the connection applies real backpressure over TCP — the
  client's kernel throttles its send rate once our receive window stops
  advancing — rather than reading everything at full speed and imposing a
  limit somewhere downstream where it can no longer affect actual wire
  throughput.

### Why the wrapping point matters

`Handler.throttleUploadBody` (`api/routes/files.go`) must run **before**
anything touches `c.Request.Body` — including Gin's `c.FormFile`/`c.PostForm`,
which trigger `http.Request.ParseMultipartForm` and read the *entire* request
body up front on first call. Throttling anything after that point (e.g. the
`io.ReadAll` calls already present in the chunk handlers) would only be
pacing access to bytes already fully received over the wire — it would slow
down in-memory processing, not actual network throughput. Every upload
handler calls `throttleUploadBody` immediately after establishing the
caller's identity (cookie session or presigned-token claim) and before its
first `FormFile`/`PostForm` call:

| Handler | Route | Identity source |
|---------|-------|------------------|
| `UploadFile` | `POST /files/upload` | `c.GetString("userID")` (cookie auth) |
| `UploadChunk` | `POST /files/upload/:upload_id/chunk` | `c.GetString("userID")`, cross-checked against the session owner |
| `UploadFilePresigned` | `POST /files/upload/p` | presigned token claim (`claim.UserID`) |
| `UploadChunkPresigned` | `POST /files/upload/:upload_id/chunk/p` | presigned token claim, cross-checked against the session owner |

`POST /shares/:share_id/upload` (public share-link uploads from users with no
account) is **not** covered — that flow has no stable per-user identity to
key a fair share on, and was out of scope for this pass.

## Wiring

`cmd/main.go` constructs `services.NewBandwidthManager()` (no speed source
yet) early, wires it into `routes.Handler` via `routes.SetBandwidthManager`,
then — once the admin handler exists — wires the two sides of the feedback
loop together: `adminHandler.SetBandwidthManager(bandwidthMgr)` (so the speed
test can check `hasActiveUploads`) and `bandwidthMgr.SetSpeedSource(adminHandler)`
(so the manager can read `CleanNetworkSpeedMbps`, which `*admin.Handler`
implements).

There is nothing to configure — the cap self-calibrates to whatever the
periodic speed test measures. If uploads feel too restricted or too loose,
that points at the underlying speed test reading (`GET
/admin/system/speed-test`) rather than a tunable here.
