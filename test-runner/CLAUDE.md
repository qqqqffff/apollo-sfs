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

Each suite is run through its toolchain's structured/JSON reporter (`go test
-json -cover`, Jest `--json --coverage --coverageReporters=json-summary`,
Playwright `--reporter=json,list` via `PLAYWRIGHT_JSON_OUTPUT_NAME`,
`pytest --json-report --cov --cov-report=json`), so `result` carries a
per-test breakdown and line/branch coverage, not just an aggregate pass/fail —
see the `parse*()` functions in `server.js`, one per toolchain. A suite whose
structured output can't be parsed (crashed before producing one) still
reports `passed`/`exit_code`/`output`/`duration_ms`; it just omits
`tests`/`coverage` rather than failing the whole run. Playwright E2E has no
meaningful coverage concept and always omits `coverage`.

```json
{
  "backend": {
    "enabled": true,
    "result": {
      "passed": true, "exit_code": 0, "output": "...", "duration_ms": 3316,
      "num_tests": 42, "num_passed": 42, "num_failed": 0,
      "tests": [{ "name": "TestFoo", "passed": true, "duration_ms": 12 }],
      "coverage": { "lines_pct": 87.5, "branches_pct": null }
    }
  },
  "frontend":     { "enabled": true, "result": { "...": "same shape, coverage.branches_pct populated" } },
  "frontend_e2e": { "enabled": true, "result": { "...": "same shape, no coverage key" } },
  "mobile":       { "enabled": true, "result": { "..." : "same shape as frontend" } },
  "recognition":  { "enabled": true, "result": { "..." : "same shape, coverage from pytest-cov" } }
}
```

This shape is consumed directly by `api/routes/admin/tests.go`
(`models.TestRunReport` in `api/models/test_run.go`) — the Go side just
proxies it, computing the aggregate HTTP status (503 nothing configured / 422
something failed / 200 all passed) rather than re-deriving each suite's
result, and persists every run (tagged with this deployment's version/git
branch) to the `test_runs` table so `GET /admin/system/tests/latest` can serve
a cached run back without re-running the whole suite. The frontend groups the
five suites into four application areas (Frontend = frontend + frontend_e2e,
API = backend, Recognition, Mobile) on the admin metrics page's test-runner
card — see `frontend/src/routes/_auth.admin/metrics.tsx`.

## Adding a suite

1. Add the toolchain/deps to `Dockerfile` (a new `COPY .../package.json` + install step, following the existing per-service sections).
2. Add a `run*Suite(...)` function in `server.js` (following the existing per-toolchain parse/run pairs) and a key in `runAllSuites()`'s returned object.
3. Add the matching field to `models.TestRunReport` in `api/models/test_run.go` and to `TestRunReport` in `frontend/src/api/admin.ts`.
4. Add it to the relevant application-area group (or a new one) in `frontend/src/routes/_auth.admin/metrics.tsx`'s test-runner card.
