# Test Runner (Unified Sidecar)

A single Docker Swarm service (`docker-stack.yml`, see root `CLAUDE.md`) that runs every service's test suite from one container and returns one combined JSON report, instead of a separate sidecar per service. It backs the admin metrics page's "Run tests" button — the `api` service POSTs to it over the overlay network (`TEST_RUNNER_URL`) and proxies the report straight through.

Swarm-only, like `recognition`: the deprecated `docker-compose.yml` has no `test-runner` service, so "Run tests" is inert under compose. Build + push it like every other custom image — `./deploy.sh --services test-runner` (own tag var `TEST_RUNNER_TAG`, amd64 only, pinned to the manager via `node.labels.tier == standard`) — see `docs/registry_setup.md`.

## Why one container

`api/`, `frontend/`, and `mobile/` each live in their own container, so the `api` service can't `exec` their test suites directly — something has to bridge the gap. Rather than a sidecar per service (as this repo used to have — `api-tests`, `frontend-tests`, `mobile-tests`), one container carries every toolchain needed and runs all five suites in sequence:

| Suite | Command | Directory |
|-------|---------|-----------|
| Backend | `go test ./tests/... -count=1` | `api/` |
| Frontend (Jest) | `npm test` | `frontend/` |
| Frontend E2E (Playwright) | `npm run test:e2e` | `frontend/` (against the live `frontend` container) |
| Mobile (Jest) | `npm test` | `mobile/` (native modules mocked — no Xcode/Android SDK) |
| Recognition (pytest) | `python -m pytest tests/ -v` | `recognition/` (fake pipelines — no model files/ORT) |

Sequential, not parallel — this container has limited CPU/RAM (it runs on the same dev host as everything else) and five toolchains contending for the same cores at once isn't worth the wall-clock savings.

## Files

- `Dockerfile` — multi-toolchain image. Go's official image is used only to donate a compiled toolchain (`COPY --from=go-toolchain /usr/local/go`) onto a `node:22-bookworm-slim` base (needed for Playwright's Chromium, which requires glibc); Python comes from Debian bookworm's `apt` package (close enough to the recognition service's own `python:3.12-slim` for running tests, even though it isn't an exact version match — this is test tooling, not a deployed image). Recognition's Python deps install into a dedicated venv (`/opt/recognition-venv`) since Debian's system Python is "externally managed" (PEP 668).
- `server.js` — the sidecar's HTTP server (CommonJS, no build step). `POST /run-tests` runs all five suites and returns the combined report; `GET /health` is a liveness probe.

**Build context must be the repo root**, not this directory — the Dockerfile needs `api/`, `frontend/`, `mobile/`, and `recognition/` all in its build context simultaneously. See `docker-stack.yml`'s `test-runner` service (image `apollo-sfs_test-runner:${TEST_RUNNER_TAG}`) and `deploy.sh`'s `IMAGE_CONTEXT[test-runner]="."` / `IMAGE_DOCKERFILE[test-runner]="test-runner/Dockerfile"`.

## Triggering a run

Normally via the admin metrics page's "Run tests" button. To trigger manually from the manager (the service publishes no ports and is reachable only on the overlay network, same as `recognition`):

```bash
docker exec "$(docker ps -q -f name=apollo-sfs_api)" \
  wget -qO- --post-data='' http://test-runner:9228/run-tests
```

## Report shape

```json
{
  "backend":      { "enabled": true, "result": { "passed": true, "exit_code": 0, "output": "...", "duration_ms": 3316 } },
  "frontend":     { "enabled": true, "result": { ... } },
  "frontend_e2e": { "enabled": true, "result": { ... } },
  "mobile":       { "enabled": true, "result": { ... } },
  "recognition":  { "enabled": true, "result": { ... } }
}
```

This shape is consumed directly by `api/routes/admin/tests.go` (`testRunResponse`) — the Go side just proxies it, computing the aggregate HTTP status (503 nothing configured / 422 something failed / 200 all passed) rather than re-deriving each suite's result. The frontend renders it on the admin metrics page's "Run tests" panel, one row + expandable output block per suite.

## Adding a suite

1. Add the toolchain/deps to `Dockerfile` (a new `COPY .../package.json` + install step, following the existing per-service sections).
2. Add a `runSuite(...)` call in `server.js`'s `runAllSuites()`, and a key in the object it returns.
3. Add the matching field to `testRunResponse` in `api/routes/admin/tests.go` and to `TestRunResponse` in `frontend/src/api/admin.ts`.
4. Add a `<TestSuiteRow>` (and `<OutputBlock>`) for it in `frontend/src/routes/_auth.admin/metrics.tsx`.
