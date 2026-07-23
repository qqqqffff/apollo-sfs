# Unified test-runner sidecar image.
#
# Runs every service's test suite from ONE container instead of a separate
# sidecar per service (api-tests/frontend-tests/mobile-tests/recognition-tests):
#   - Go unit tests            (api/)
#   - Jest unit tests          (frontend/)
#   - Playwright E2E tests     (frontend/, against the live `frontend` container)
#   - Jest unit tests          (mobile/ — native modules are mocked, no Xcode/Android SDK needed)
#   - pytest unit tests        (recognition/ — fake pipelines, no model files/ORT needed)
#
# POST /run-tests runs all five and returns one combined JSON report; server.js
# is the only thing that changes per suite (which command, which directory).
# This image is NOT any production service and is never deployed to production.
#
# Build context MUST be the repo root (not this directory) — see docker-compose.yml.

# Go toolchain, built on the same Debian base as the final image so the
# compiled toolchain's glibc matches (golang's default tag is Debian-based).
FROM golang:1.26.2-bookworm AS go-toolchain

# node:*-bookworm-slim (not alpine) because Playwright's Chromium needs glibc.
FROM node:22-bookworm-slim

COPY --from=go-toolchain /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}"
ENV GOPATH=/root/go
ENV PATH="${GOPATH}/bin:${PATH}"

# Python for the recognition suite (Debian bookworm ships 3.11, close enough to
# the service's python:3.12-slim — this is test tooling, not the deployed
# image) + Playwright's Chromium system deps (same set `playwright install-deps
# chromium` would pull in, pinned so the build is offline after the layer caches).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    libglib2.0-0 \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Go deps (api/) — download before copying source so this layer is reused
# on code-only changes. ──
COPY api/go.mod api/go.sum ./api/
RUN cd api && go mod download

# ── Frontend deps ──
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci
RUN cd frontend && npx playwright install chromium

# ── Mobile deps ──
COPY mobile/package.json mobile/package-lock.json ./mobile/
RUN cd mobile && npm ci

# ── Recognition deps — Debian bookworm's system Python is "externally
# managed" (PEP 668), so installs go into a dedicated venv rather than
# fighting apt's pip. pytest-json-report/pytest-cov are sidecar-only tooling
# (structured per-test + coverage output for the admin metrics page's
# test-runner card), not part of recognition/'s own requirements-test.txt. ──
COPY recognition/requirements.txt recognition/requirements-test.txt ./recognition/
RUN python3 -m venv /opt/recognition-venv \
    && /opt/recognition-venv/bin/pip install --no-cache-dir \
         -r recognition/requirements.txt -r recognition/requirements-test.txt \
         pytest-json-report==1.5.0 pytest-cov==5.0.0

# Now the full source trees.
COPY api ./api
COPY frontend ./frontend
COPY mobile ./mobile
COPY recognition ./recognition
COPY test-runner/server.js ./server.js

# Pre-compile the Go test packages so the first /run-tests call doesn't pay a
# cold-compile penalty.
RUN cd api && go test -run=^$ ./tests/... -count=1

EXPOSE 9228

CMD ["node", "server.js"]
