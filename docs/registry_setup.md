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

## Automated deploy script

Once the one-time setup below is done, **`deploy.sh`** automates the
build → push → `docker stack deploy` sequence described in this guide, including
the per-service tag handling in
[Per-service tags](#per-service-tags--why-not-one-shared-tag):

```bash
./deploy.sh
```

Run with no arguments in an interactive terminal and it shows a checklist —
up/down (or j/k) to move, space to toggle `frontend`/`api`/`node-agent`, enter to
confirm — then builds + pushes only what you selected under a fresh tag
(`git rev-parse --short HEAD` by default). For every service you did **not**
select, it asks the running Swarm what tag it's already on
(`docker service inspect`) and redeploys that unchanged — there's no separate
tracking file to keep in sync; the running cluster is the source of truth. For
scripted/non-interactive use: `--services frontend,api`, `--tag <value>`,
`--registry <host:port>`, `--deploy-only` (skip build, redeploy every service
with whatever tag is currently running), `--dry-run`, `-y`. Run
`./deploy.sh --help` for the full list.

The rest of this document explains what the script is doing and how to do each
step by hand — useful the first time through, or if you need to deviate from the
script's assumptions.

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

Use an address **every node can reach and resolve identically** — the manager's
stable LAN IP, `192.168.68.57:5000`. An IP needs no name resolution, so it works
the same from every node and from the buildx builder container. Give the manager
a static lease/reservation for this IP so it never changes.

(Avoid a hostname like `apollo-sfs-1:5000` here — on the manager itself that name
usually resolves to `127.0.1.1`, the loopback address, which is *not* reachable
from other nodes; every worker would then need its own `/etc/hosts` entry or real
DNS pointing the name at the manager's LAN IP. The IP sidesteps that entirely.)

`docker-stack.yml` and `deploy.sh` both default `REGISTRY` to `192.168.68.57:5000`
when unset, so you don't normally need to export it — only do so if the manager's
IP ever changes:

```bash
export REGISTRY=192.168.68.57:5000   # manager LAN IP
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
  "insecure-registries": ["192.168.68.57:5000"]
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
curl -s http://192.168.68.57:5000/v2/_catalog
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
[registry."192.168.68.57:5000"]
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

## Per-service tags — why not one shared `TAG`

`docker-stack.yml` pins each custom image to its **own** tag variable —
`API_TAG`, `FRONTEND_TAG`, `NODE_AGENT_TAG` — not a single shared `TAG`. This
matters the moment you redeploy only one service: if all three images shared one
`TAG`, redeploying just the frontend under a new tag would also point `api` and
`node-agent` at that same (never-built, never-pushed) tag, and the deploy would
fail like this:

```
image 192.168.68.57:5000/apollo-sfs-node-agent:b6eadb7 could not be accessed on a
registry to record its digest. Each node will access ... independently, possibly
leading to different nodes running different versions.
```

That happens because the tag simply doesn't exist in the registry for that image
— you never pushed it. With independent variables, redeploying the frontend only
changes `FRONTEND_TAG`; `API_TAG` and `NODE_AGENT_TAG` need to keep pointing at
whatever was last actually built and pushed for them. That's the "fallback to the
previously built version" behaviour for anything you didn't touch.

There's no tracking file for this (no `deploy.env`) — instead, `deploy.sh` asks
the **running Swarm** what tag each untouched service is already on, right before
every deploy:

```bash
docker service inspect --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' apollo-sfs_api
docker service inspect --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' apollo-sfs_frontend
docker service inspect --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' apollo-sfs_node-agent-fast
```

That output is `<registry>/<image>:<tag>`; the tag after the last `:` is fed back
in as that service's variable. Since the cluster itself is always current, there's
nothing to keep in sync by hand, and nothing that can drift out of date. The one
case this can't cover is the **very first deploy**, before anything is running yet
— `deploy.sh` detects that (no service to inspect) and tells you which service(s)
to include so they get built instead of assumed.

---

## Build, tag, and push

Pick a tag for the version you're shipping. The short git SHA is a good default
(unique per commit, sortable, ties the image back to source). Build and push
**only the image(s) that changed** — you do not need to rebuild everything:

```bash
export REGISTRY=192.168.68.57:5000
cd /home/apollo/apollo-sfs
NEW_TAG=$(git rev-parse --short HEAD)

# Example: only the frontend changed.
docker buildx build --platform linux/amd64 \
  -t ${REGISTRY}/apollo-sfs_frontend:${NEW_TAG} frontend/ --push
```

Other images and their build commands, for reference:

```bash
# API — build both arches so a future tier=standard worker on arm64 could schedule it too.
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ${REGISTRY}/apollo-sfs_api:${NEW_TAG} api/ --push

# Node agent — runs on every node, so it MUST be multi-arch.
docker buildx build --platform linux/amd64,linux/arm64 \
  -f api/Dockerfile.node-agent \
  -t ${REGISTRY}/apollo-sfs-node-agent:${NEW_TAG} api/ --push
```

Confirm the tag landed:

```bash
curl -s http://${REGISTRY}/v2/apollo-sfs_frontend/tags/list
```

> Always push a **new** tag for a change. Swarm only rolls out a service when its
> image reference changes; re-pushing the same tag (e.g. `:latest`) leaves the spec
> identical and the update is silently skipped.

---

## Redeploying a single service

The easy way — this is exactly what `deploy.sh` automates:

```bash
./deploy.sh --services frontend      # or run it bare for the interactive checklist
```

It builds + pushes just that image under a new tag, resolves `api`'s and
`node-agent`'s currently-deployed tags live from the Swarm, and deploys with all
three set correctly.

The equivalent by hand — e.g. only the frontend changed:

```bash
export REGISTRY=192.168.68.57:5000
NEW_TAG=$(git rev-parse --short HEAD)

# 1. Build + push just that image under the new tag.
docker buildx build --platform linux/amd64 \
  -t ${REGISTRY}/apollo-sfs_frontend:${NEW_TAG} frontend/ --push

# 2. Set FRONTEND_TAG to the new tag; set API_TAG/NODE_AGENT_TAG to whatever is
#    already deployed, so those services redeploy unchanged (no rebuild needed).
export FRONTEND_TAG=${NEW_TAG}
export API_TAG=$(docker service inspect --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' apollo-sfs_api | sed 's/.*://')
export NODE_AGENT_TAG=$(docker service inspect --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' apollo-sfs_node-agent-standard | sed 's/.*://')

# 3. Load secrets and deploy.
set -a && source .env && set +a
docker stack deploy -c docker-stack.yml apollo-sfs

docker stack services apollo-sfs       # watch rollout
```

Swap `FRONTEND_TAG`/`frontend/`/`apollo-sfs_frontend` for `API_TAG`/`api/`/
`apollo-sfs_api` or `NODE_AGENT_TAG`/`api/ -f api/Dockerfile.node-agent`/
`apollo-sfs-node-agent` to redeploy the API or node-agent instead. To redeploy
everything at once, build + push all three and set all three variables to their
new tag directly (no inspecting needed, since none of them are staying put).

`REGISTRY`, `API_TAG`, `FRONTEND_TAG`, and `NODE_AGENT_TAG` are substituted into
the image references in `docker-stack.yml`
(`${REGISTRY:-192.168.68.57:5000}/<image>:${..._TAG}`). All must be set in the
deploying shell; a missing one fails the deploy loudly rather than silently
deploying an unpushed tag.

---

## Versioning and rollback

Because images are immutable per tag, rolling back is just pointing the relevant
variable at an older tag — provided that tag is still in the registry:

```bash
# Roll back just the API to a known-good tag (must still be in the registry).
# frontend/node-agent are resolved live so they stay exactly as they are now.
export API_TAG=<previous-sha-or-version>
export FRONTEND_TAG=$(docker service inspect --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' apollo-sfs_frontend | sed 's/.*://')
export NODE_AGENT_TAG=$(docker service inspect --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' apollo-sfs_node-agent-standard | sed 's/.*://')
set -a && source .env && set +a
docker stack deploy -c docker-stack.yml apollo-sfs

# Or roll back a single service to its immediately-previous spec — simplest option,
# no tag bookkeeping at all:
docker service rollback apollo-sfs_api
```

Tagging conventions that work well:

- **Per-commit:** `$(git rev-parse --short HEAD)` — every deploy is traceable to
  a commit; keep the last several around for instant rollback.
- **Release tags:** `v1.2.0` for milestones, in addition to the SHA, so humans
  have a memorable handle. You can push the same build under two tags:
  ```bash
  docker buildx build --platform linux/amd64,linux/arm64 \
    -t ${REGISTRY}/apollo-sfs_api:$(git rev-parse --short HEAD) \
    -t ${REGISTRY}/apollo-sfs_api:v1.2.0 \
    api/ --push
  ```

Avoid relying on `:latest` for deploys — it defeats both change-detection and
rollback, and is exactly what per-service tags are meant to replace.

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
| service not updating after a push | re-used the same tag | push a new tag; Swarm only redeploys on an image-reference change |
| `image ...:<tag> could not be accessed on a registry to record its digest` | that tag was never pushed for that image — usually because a shared `TAG` was reused across services and only one was actually built | use the per-service `API_TAG`/`FRONTEND_TAG`/`NODE_AGENT_TAG` vars; only set the variable for the image you actually pushed to the new tag, and resolve the others from `docker service inspect` (or just use `./deploy.sh`, which does this automatically) |

See also: [README.md](../README.md) → *Docker Swarm — Deploying and Redeploying*.
