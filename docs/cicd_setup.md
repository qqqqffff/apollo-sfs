# CI/CD — GitHub Actions "Deploy All"

`.github/workflows/deploy.yml` + `.github/actions/deploy-all/action.yml` give you a
one-click, manually-triggered deploy from GitHub's Actions tab that always builds,
pushes, and deploys **every** Apollo SFS service — no checklist, no `--services`
selection. It's a CI-friendly companion to `deploy.sh` (docs/registry_setup.md),
not a replacement: use `deploy.sh` locally on the manager for selective redeploys,
rollbacks, or `--deploy-only` config reapplies; use this workflow when you want
"ship everything on `main` right now" from a browser/phone with no SSH session.

## Why a self-hosted runner is required

GitHub-hosted runners live outside your network and can't reach:

- the private registry (`192.168.68.57:5000`, plain HTTP, LAN-only, see
  docs/registry_setup.md), or
- the Swarm manager's Docker socket (`docker stack deploy` needs to run *on* a
  manager node).

So the workflow's job (`runs-on: [self-hosted, apollo-manager]`) must execute on
the manager itself, using the same buildx builder, registry trust config, and
Swarm context that manual `deploy.sh` runs already rely on. There is no
GitHub-hosted-runner path here short of exposing the registry and Swarm socket to
the internet with real auth in front of them — not recommended for a home-lab
cluster.

## One-time setup

### 1. Complete the registry/buildx setup

If you haven't already, do the one-time steps in
[docs/registry_setup.md](registry_setup.md) on the manager (registry container,
`insecure-registries`, QEMU binfmt, the `apollo-builder` buildx builder). The
workflow assumes all of that already works — it's exactly what `deploy.sh` needs
too.

### 2. Install a self-hosted runner on the manager

From the repo's GitHub Settings → Actions → Runners → "New self-hosted runner",
follow GitHub's generated commands on the manager, e.g.:

```bash
mkdir actions-runner && cd actions-runner
curl -o actions-runner.tar.gz -L https://github.com/actions/runner/releases/latest/download/actions-runner-linux-x64-<version>.tar.gz
tar xzf actions-runner.tar.gz
./config.sh --url https://github.com/<org>/apollo-sfs --token <token> --labels apollo-manager
sudo ./svc.sh install
sudo ./svc.sh start
```

The `--labels apollo-manager` flag matters — `deploy.yml` targets
`runs-on: [self-hosted, apollo-manager]` specifically, so a stray self-hosted
runner elsewhere (e.g. a laptop) can never accidentally pick up a production
deploy job.

Run the runner as a service user that's already in the `docker` group (so it can
run `docker buildx`/`docker stack deploy` without `sudo`), matching whatever user
normally runs `deploy.sh` by hand.

### 3. Point the workflow at your production `.env`

The workflow does **not** ask you to duplicate secrets into GitHub Actions
Secrets. `.env` already lives on the manager for `deploy.sh`'s own use — the
workflow's "Load production .env" step just copies that file into its checkout:

```bash
cp "${APOLLO_SFS_ENV_PATH:-/home/apollo/apollo-sfs/.env}" .env
```

If your production checkout isn't at `/home/apollo/apollo-sfs`, set
`APOLLO_SFS_ENV_PATH` in the runner service's environment (e.g. in the systemd
override for the `actions.runner.*` service, or `actions-runner/.env` — see
GitHub's runner docs on configuring environment variables) rather than editing
the workflow file.

This keeps every secret (`KEY_ENCRYPTION_KEY`, `PAYPAL_*`, `MINIO_*`,
`SFS_API_KEY_PEPPER`, etc.) out of GitHub entirely — nothing to keep in sync in
two places, and nothing exposed if the repo or a workflow log is ever shared.

## What the workflow does

`deploy.yml` checks out the triggering commit, loads `.env`, then runs the
`deploy-all` composite action, which mirrors `deploy.sh`'s steps one-for-one but
always for every service (see the per-service tables — `ORDER`, `IMAGE_REPO`,
`IMAGE_CONTEXT`, `IMAGE_DOCKERFILE`, `IMAGE_PLATFORMS`, `BUNDLE` — near the top of
`deploy.sh`, which this action's steps are kept in sync with by hand):

1. **Preflight checks** — docker/buildx present, `.env` present, the same
   `RECOGNITION_MEM_LIMIT` unit-suffix guard `deploy.sh` runs.
2. **Resolve build tag** — `TAG` = short git SHA of the checked-out commit (same
   default as `deploy.sh`); `REGISTRY` defaults to `192.168.68.57:5000`.
3. **Ensure buildx builder** — reuses `apollo-builder` if present, else creates it.
4. **Apply DB migrations** — `db/apply-migrations.sh`, unconditionally, every run
   (migrations are idempotent — see docs/storage_node_setup.md).
5. **Build & push** frontend, api, node-agent, node-metrics-ingest, recognition,
   test-runner — each its own step, each pushed under the same `$TAG`.
6. **Deploy stack** — all six tag variables set to `$TAG` (nothing is left
   "currently deployed, unchanged" the way `deploy.sh` allows — every run
   redeploys every service), then `docker stack deploy`.
7. **Show rollout** — `docker stack services apollo-sfs`.

Because every run rebuilds and redeploys everything, there's no `--services`
input to add here — that selective-rebuild logic (and its "ask the Swarm what's
currently deployed" fallback) is what makes `deploy.sh` a different, complementary
tool rather than something this workflow calls into directly.

## Running it

GitHub → Actions tab → "Deploy All" → "Run workflow" → pick the branch/commit →
Run. Only one deploy runs at a time (`concurrency: group: apollo-sfs-deploy`) —
a second manual trigger while one is in flight queues behind it rather than
racing it.

## Keeping it in sync with `deploy.sh`

If you add, rename, or reconfigure a service in `deploy.sh` (its `IMAGE_REPO`/
`IMAGE_CONTEXT`/`IMAGE_DOCKERFILE`/`IMAGE_PLATFORMS`/`BUNDLE` entries), update
`.github/actions/deploy-all/action.yml`'s matching step the same way — the two
aren't generated from a shared source, so they can drift if only one is edited.
