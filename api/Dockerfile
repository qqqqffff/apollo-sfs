# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM golang:1.26.2-alpine AS builder

WORKDIR /build

# Fetch dependencies before copying source so this layer is reused on
# code-only changes (go.mod and go.sum are rarely edited).
COPY go.mod go.sum ./
RUN go mod download

# Copy the full source tree and compile a static binary.
# CGO_ENABLED=0 removes all libc dependency — the binary runs in distroless.
# -ldflags "-s -w" strips the symbol table and DWARF debug info (~30% smaller).
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build \
      -ldflags="-s -w" \
      -o /build/api \
      ./cmd

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
# Alpine provides FFmpeg (for background video transcoding) while staying
# minimal. uid 65532 matches the distroless nonroot convention.
FROM alpine:3.21

RUN apk add --no-cache ca-certificates ffmpeg tzdata util-linux iputils \
    && adduser -D -H -u 65532 -s /sbin/nologin nonroot

WORKDIR /app

# Deployed version (deploy.sh's image tag, normally a git short SHA) and git
# branch, baked in at build time so the admin metrics page's test-runner card
# can label each stored test run with what was actually running. Empty in a
# local `docker build` with no --build-arg — the test-runner card just shows
# "unknown" for both.
ARG APP_VERSION=""
ARG APP_GIT_BRANCH=""
ENV APP_VERSION="${APP_VERSION}"
ENV APP_GIT_BRANCH="${APP_GIT_BRANCH}"

COPY --from=builder /build/api .

# Email templates are read from disk at runtime.
# TODO: replace with //go:embed in email.go to fold them into the binary and
#       remove this COPY instruction.
COPY --from=builder /build/templates ./templates

EXPOSE 8080

USER nonroot

ENTRYPOINT ["/app/api"]
