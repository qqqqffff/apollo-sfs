# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /build

# Install deps before copying source so this layer is reused on code-only changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Build-time frontend configuration. Vite inlines VITE_* env vars into the
# bundle, so these must be present at `npm run build` time, not at runtime.
# The value comes from the root .env via deploy.sh (--build-arg); an empty
# value just disables the Microsoft option in the email backup dialog.
ARG VITE_MS_CLIENT_ID=""
ENV VITE_MS_CLIENT_ID=$VITE_MS_CLIENT_ID

RUN npm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM nginx:alpine

COPY --from=builder /build/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
