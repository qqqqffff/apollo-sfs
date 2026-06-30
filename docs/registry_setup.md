# Private Image Registry

Apollo SFS runs as a multi-node Docker Swarm. Every node that schedules a custom
service (`api`, `frontend`, `node-agent`) needs that service's image for its own
CPU architecture. Building the image on each node by hand does not scale — as soon
as you add a third node you are rebuilding three places for every change.

A **private registry** solves this: you build each image **once** (multi-arch),
push it to the registry, and every node — current or future — pulls the version it
needs. This is the supported production workflow. Images are versioned by **tag**,
so deploys and rollbacks are just a tag change.

> Local single-node development (`docker-compose.yml`) does **not** use the
> registry — Compose builds images locally. The registry is a Swarm concern only.

---

## How it fits together

```
                build + push (once, all arches)
   manager ───────────────────────────────────────►  registry  (registry:2 on the manager, :5000)
      │                                                   ▲
      │ docker stack deploy                               │ pull <REGISTRY>/<image>:<TAG>
      ▼                                                   │
   Swarm schedules tasks ──► each node pulls its arch ────┘
   (manager amd64, Pi 5 arm64, future nodes …)
```

- The registry is a single `registry:2` container on the **manager**, listening on
  port `5000`, data persisted to a host volume.
- It is served over **plain HTTP** on the LAN (no TLS). That is fine for a private,
  firewalled cluster, but every Docker daemon that talks to it must be told the
  registry is "insecure" (HTTP). See [Trusting the registry](#2-trust-the-registry-on-every-node).
- Images are addressed as `${REGISTRY}/<name>:<TAG>` where `REGISTRY` is the
  registry endpoint (host\:port) and `TAG` is your version string.

### Choosing the `REGISTRY` value

Use an address **every node can reach and resolve identically**:

- **Recommended:** the manager's stable LAN IP, e.g. `192.168.1.10:5000`. An IP
  needs no name resolution, so it works the same from every node and from the
  buildx builder container. Give the manager a static lease / reservation.
- **Alternative:** a hostname (e.g. `apollo-sfs-1:5000`) — but then **every** node
  (and the build tooling) must resolve that name to the manager's LAN IP. On the
  manager itself `apollo-sfs-1` usually resolves to `127.0.1.1` (loopback), which
  is fine for the manager but means other nodes need an `/etc/hosts` entry or real
  DNS pointing the name at the manager's LAN IP.

The stack file defaults `REGISTRY` to `apollo-sfs-1:5000` when unset, but exporting
an explicit IP is the least surprising:

```bash
export REGISTRY=192.168.1.10:5000   # manager LAN IP
```

---

## One-time setup

### 1. Start the registry on the manager

```bash
docker run -d --name registry --restart=always \
  -p 5000:5000 \
  -v /srv/registry:/var/lib/registry \
  registry:2
```

- `--restart=always` brings it back after a reboot.
- `-v /srv/registry:/var/lib/registry` persists pushed images on the host (without
  this, every restart loses all images and the next deploy fails to pull).

Verify it answers locally:

```bash
curl -s http://127.0.0.1:5000/v2/_catalog    # -> {"repositories":[]}
```

> Run the registry as a plain `docker run` container (above), **not** as a service
> in `docker-stack.yml`. It must be up *before* a stack deploy so nodes can pull,
> and keeping it outside the stack avoids a chicken-and-egg dependency.

### 2. Trust the registry on every node

Plain-HTTP registries must be allow-listed in each daemon. On **every** node
(manager and all workers), edit `/etc/docker/daemon.json`:

```json
{
  "insecure-registries": ["192.168.1.10:5000"]
}
```

Use the **same** `REGISTRY` value you chose above. Then restart Docker:

```bash
sudo systemctl restart docker
```

If you addressed the registry by hostname instead of IP, also make sure the name
resolves to the manager's LAN IP on that node (`getent hosts <name>` should print
the manager's LAN IP, not `127.0.0.1`/`127.0.1.1`). Add an `/etc/hosts` entry if
needed.

Confirm a worker can reach it:

```bash
# from the Pi / any worker
curl -s http://192.168.1.10:5000/v2/_catalog
```

### 3. Set up multi-arch builds on the manager

The cluster mixes architectures (amd64 manager, arm64 Pi), so `api` and
`node-agent` must be built for both. You build both arches on the manager using
QEMU emulation + a buildx "container" builder.

```bash
# a) Register QEMU emulators so the manager can build arm64 (one-time, re-run after reboot)
docker run --privileged --rm tonistiigi/binfmt --install all

# b) Tell the builder the registry is insecure HTTP (use YOUR REGISTRY value)
cat > /tmp/buildkitd.toml <<EOF
[registry."192.168.1.10:5000"]
  http = true
  insecure = true
EOF

# c) Create a container-driver builder on the host network so it can reach the
#    registry exactly like the daemon does, and trust the insecure registry
docker buildx create --name apollo-builder --driver docker-container \
  --driver-opt network=host \
  --config /tmp/buildkitd.toml --bootstrap --use
```

Why each piece matters (these are the failure modes to recognise):

- **`binfmt --install all`** — without it the arm64 build stage fails with
  `exec /bin/sh: exec format error` (the host can't run arm64 binaries).
- **`--driver network=host`** — the default buildx builder runs in its own network
  namespace with its own DNS, so it can't resolve a LAN hostname and push fails with
  `dial tcp: lookup <host> … no such host`. Host networking (plus addressing the
  registry by IP) avoids this.
- **buildkitd `http/insecure`** — without it the push fails with
  `http: server gave HTTP response to HTTPS client` (the builder defaults to HTTPS).

---

## Build, tag, and push

Pick a `TAG` for the version you're shipping. The short git SHA is a good default
(unique per commit, sortable, ties the image back to source):

```bash
export REGISTRY=192.168.1.10:5000
export TAG=$(git rev-parse --short HEAD)     # or e.g. v1.2.0
```

Build and push every custom image **to the registry** in one go (the manager builds
all arches; buildx pushes a multi-arch manifest so each node pulls its own):

```bash
cd /home/apollo/apollo-sfs

# API — runs on the manager today, but build both arches so a future
# tier=standard worker on arm64 could schedule it too.
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ${REGISTRY}/apollo-sfs_api:${TAG} api/ --push

# Frontend — manager (amd64) only; build amd64 to keep it lean.
docker buildx build --platform linux/amd64 \
  -t ${REGISTRY}/apollo-sfs_frontend:${TAG} frontend/ --push

# Node agent — runs on every node, so it MUST be multi-arch.
docker buildx build --platform linux/amd64,linux/arm64 \
  -f api/Dockerfile.node-agent \
  -t ${REGISTRY}/apollo-sfs-node-agent:${TAG} api/ --push
```

Confirm the tags landed:

```bash
curl -s http://${REGISTRY}/v2/apollo-sfs_api/tags/list
curl -s http://${REGISTRY}/v2/apollo-sfs-node-agent/tags/list
```

> Always push a **new** `TAG` for a change. Swarm only rolls out a service when its
> image reference changes; re-pushing the same tag (e.g. `:latest`) leaves the spec
> identical and the update is silently skipped.

---

## Deploy from the registry

With every custom image in the registry, deploy normally — Swarm resolves each tag
and **each node pulls** the image it needs. No per-node builds, no
`--resolve-image never`.

```bash
export REGISTRY=192.168.1.10:5000
export TAG=$(git rev-parse --short HEAD)
set -a && source .env && set +a        # stack deploy does not auto-read .env

docker stack deploy -c docker-stack.yml apollo-sfs

docker stack services apollo-sfs       # watch rollout
docker stack ps apollo-sfs
```

`REGISTRY` and `TAG` are substituted into the image references in
`docker-stack.yml` (`${REGISTRY:-apollo-sfs-1:5000}/<image>:${TAG}`). Both must be
exported in the deploying shell; an unset `TAG` fails the deploy loudly (intended).

To redeploy after a code change: re-run the build/push for the changed image with a
new `TAG`, then re-run the same `docker stack deploy`. Unchanged services (Keycloak,
MinIO, Postgres, …) are left untouched.

---

## Versioning and rollback

Because images are immutable per tag, rolling back is just deploying an older tag —
provided that tag is still in the registry:

```bash
# Roll the whole stack back to a known-good version
export REGISTRY=192.168.1.10:5000
export TAG=<previous-sha-or-version>
set -a && source .env && set +a
docker stack deploy -c docker-stack.yml apollo-sfs

# Or roll back a single service to its immediately-previous spec
docker service rollback apollo-sfs_api
```

Tagging conventions that work well:

- **Per-commit:** `TAG=$(git rev-parse --short HEAD)` — every deploy is traceable to
  a commit; keep the last several around for instant rollback.
- **Release tags:** `TAG=v1.2.0` for milestones, in addition to the SHA, so humans
  have a memorable handle. You can push the same build under two tags:
  ```bash
  docker buildx build --platform linux/amd64,linux/arm64 \
    -t ${REGISTRY}/apollo-sfs_api:$(git rev-parse --short HEAD) \
    -t ${REGISTRY}/apollo-sfs_api:v1.2.0 \
    api/ --push
  ```

Avoid relying on `:latest` for deploys — it defeats both change-detection and
rollback.

---

## Adding a new node (the payoff)

When you bring up another worker, you do **not** build anything on it:

```bash
# 1. Join the swarm (token from `docker swarm join-token worker` on the manager)
docker swarm join --token <worker-token> <manager-ip>:2377

# 2. Trust the registry on the new node (/etc/docker/daemon.json), then:
sudo systemctl restart docker

# 3. Label it so services schedule onto it
docker node update --label-add tier=<standard|fast> <new-node-id>
```

On the next `docker stack deploy`, Swarm schedules the relevant services onto the
new node and it pulls the right-arch images straight from the registry.

---

## Maintenance

```bash
# List repositories and tags
curl -s http://${REGISTRY}/v2/_catalog
curl -s http://${REGISTRY}/v2/apollo-sfs_api/tags/list

# Disk usage of the registry volume
du -sh /srv/registry
```

The registry keeps every pushed tag forever. To reclaim space from old tags, delete
the tag/manifest via the API (requires the registry to be started with
`REGISTRY_STORAGE_DELETE_ENABLED=true`), then run garbage collection:

```bash
# one-off GC (registry must allow deletes; restart with the env var if needed)
docker exec registry bin/registry garbage-collect /etc/docker/registry/config.yml
```

Keep at least the currently-deployed tag and a couple of prior versions for
rollback before GC'ing.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `exec /bin/sh: exec format error` during build | QEMU emulators not registered | `docker run --privileged --rm tonistiigi/binfmt --install all` |
| push: `dial tcp: lookup <host> … no such host` | buildx container can't resolve the LAN name | create the builder with `--driver-opt network=host` and/or address the registry by **IP** |
| push: `http: server gave HTTP response to HTTPS client` | builder defaulting to HTTPS | add the `[registry."…"] http=true insecure=true` buildkitd config to the builder |
| `connection refused` to `:5000` | registry not running, or bound to a different loopback than you curled | `docker ps | grep registry`; start it (step 1); curl the address the daemon uses |
| deploy pulls fail on a node | node missing `insecure-registries` or can't resolve `REGISTRY` | fix `/etc/docker/daemon.json` + name resolution on that node, restart Docker |
| service not updating after a push | re-used the same tag | push a new `TAG`; Swarm only redeploys on an image-reference change |

See also: [README.md](../README.md) → *Docker Swarm — Deploying and Redeploying*.
