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
# distroless/static contains only CA certificates and timezone data.
# No shell, no package manager, no OS utilities — minimal attack surface.
# The :nonroot variant runs the process as uid 65532 instead of root.
FROM gcr.io/distroless/static-debian12:nonroot

WORKDIR /app

COPY --from=builder /build/api .

# Email templates are read from disk at runtime.
# TODO: replace with //go:embed in email.go to fold them into the binary and
#       remove this COPY instruction.
COPY --from=builder /build/templates ./templates

EXPOSE 8080

ENTRYPOINT ["/app/api"]
