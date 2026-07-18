# AI Recognition Setup

Premium per-collection AI indexing: groups similar **faces**, identifies unique
**pets** (cats/dogs), and labels common **objects** across a media collection
(images + sampled video frames). Labeled groups are searchable from the search
bar on web and mobile. All inference runs on the cluster — no external APIs.

## Architecture

```
upload / toggle ──> api (Go)                      recognition (Python sidecar)
                    ├─ decrypts media             ├─ FastAPI + ONNX Runtime
                    ├─ durable job queue          ├─ stateless: image bytes in,
                    │  (recognition_jobs,         │  detections + embeddings out
                    │   fair per-user claims)     ├─ no DB / MinIO / keys
                    ├─ POST /v1/analyze ─────────>│  X-Internal-Token auth
                    ├─ clustering (Go, centroid)  └─ CUDA EP → CPU fallback
                    ├─ encrypted crops → MinIO
                    └─ groups/labels → Postgres
```

- **Privacy/keys:** the sidecar never sees encryption keys, the database, or
  MinIO. The api decrypts (the same server-side path EXIF/FFmpeg already use),
  sends plaintext bytes over the overlay network, and stores results.
- **Durability:** per-file jobs live in `recognition_jobs` (statuses
  `pending/processing/done/failed/skipped`). Claims interleave across users
  (`ROW_NUMBER() OVER (PARTITION BY user_id ...)`) so one user's giant
  collection cannot monopolize the queue. Stuck `processing` jobs are requeued
  at startup and after 10 minutes, so an api restart resumes indexing.
- **Quota:** encrypted face/pet crops (~a few KB each, `<=160px` JPEG) are
  stored on the user's drive under `{userID}/recognition/` and **count toward
  the user's storage quota** (`thumb_size_bytes`, refunded on file deletion or
  recognition-data purge). Users see the usage in the groups modal and accept
  a disclaimer before enabling.
- **Audit:** lifecycle events are written to the existing `audit_logs` table
  (`recognition_enabled`, `recognition_disabled`, `recognition_files_enqueued`,
  `recognition_index_completed`, `recognition_job_failed`,
  `recognition_group_labeled`, `recognition_groups_merged`,
  `recognition_group_deleted`) with structured JSON details, visible in the
  admin panel's per-user audit view.

## Models (all open-source, downloaded at image build)

| Role | Model | Source | License |
|------|-------|--------|---------|
| Face detection | YuNet (2023mar) | opencv/opencv_zoo (GitHub) | MIT |
| Face embedding (512-d) | AuraFace-v1 (glintr100) | HF `fal/AuraFace-v1` | Apache-2.0 |
| Object detection (80 COCO classes) | YOLOX-s | Megvii-BaseDetection/YOLOX release | Apache-2.0 |
| Pet re-ID embedding (512-d) | OpenCLIP ViT-B/32 image encoder | HF `Qdrant/clip-ViT-B-32-vision` | MIT |

Deliberately **not** ultralytics YOLOv8/v11 (AGPL-3.0 — problematic for a paid
premium tier). `recognition/download_models.py` pins sources and prints each
file's SHA-256; paste the digests into its `MODELS` table after the first
trusted build so later builds fail closed on upstream changes. Re-verify each
repo's LICENSE file if you swap models.

InsightFace's `buffalo_l` pack (SCRFD + ArcFace) is a quality upgrade for
faces, but its weights are licensed for non-commercial research only — swap it
in only if you accept that risk.

## Environment variables (root `.env`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `RECOGNITION_TOKEN` | — (required) | Shared secret for api → sidecar calls. Generate: `openssl rand -hex 32` |
| `RECOGNITION_CPU_LIMIT` | 6 (prod) / 2 (dev) | Container CPU cap — set to **~50% of the node's cores** |
| `RECOGNITION_MEM_LIMIT` | 16G (prod) / 2g (dev) | Container memory cap — set to **~50% of the node's RAM** |
| `RECOGNITION_CONCURRENCY` | 2 | api-side concurrent jobs (decrypt/crop/ffmpeg are bounded by this) |
| `RECOGNITION_MAX_KEYFRAMES` | 20 | Frames sampled per video |
| `RECOGNITION_FACE_THRESHOLD` | 0.50 | Cosine threshold to join a face group (higher = more splitting) |
| `RECOGNITION_PET_THRESHOLD` | 0.88 | Cosine threshold for individual pets (kept strict; merge UI fixes over-splits) |

`RECOGNITION_URL` is set in the compose/stack files (`http://recognition:8000`);
leaving it empty disables the feature entirely (endpoints return 503, worker
never starts).

## Threshold tuning

- Faces splitting one person into several groups → lower
  `RECOGNITION_FACE_THRESHOLD` (e.g. 0.45). Different people merged into one
  group → raise it (e.g. 0.55–0.60).
- Pet clustering via CLIP is heuristic: the strict default over-splits by
  design, and the modal's merge action is the intended fix. Lower
  `RECOGNITION_PET_THRESHOLD` only if one pet routinely produces many groups.
- Thresholds apply to *new* assignments only; re-cluster a collection by
  disabling with "delete recognition data" and re-enabling.

## Development (single-node compose)

```bash
docker compose build recognition api
docker compose up -d
# Verify the sidecar from inside the network:
docker compose exec api wget -qO- http://recognition:8000/healthz
# Apply the schema migration:
PSQL="docker compose exec -T db-app psql" ./db/apply-migrations.sh
```

Sidecar unit tests (no models needed): `cd recognition && RECOGNITION_TOKEN=test python -m pytest tests/`.

## Production (Swarm)

`./deploy.sh` now includes `recognition` as a checklist item (amd64 image,
pinned to `tier == standard` — the Ryzen manager). First deploy:

```bash
# .env: add RECOGNITION_TOKEN (+ optional limits/thresholds)
./deploy.sh --migrate --services recognition,api,frontend
```

The service publishes no ports and is never proxied by nginx; only the api can
reach it on the overlay network, and every call requires `X-Internal-Token`.

## Resource pool (~50% CPU / 50% RAM)

The `recognition` service carries the stack's only
`deploy.resources.limits` block. Size it to about half the Ryzen node:

- `RECOGNITION_CPU_LIMIT`: half the logical cores (e.g. `6` on a 12-thread CPU)
- `RECOGNITION_MEM_LIMIT`: half the installed RAM (e.g. `16G` of 32 GB)

Inside the container, ONNX Runtime's intra-op threads default to half the
visible cores (`ORT_INTRA_OP_THREADS` overrides). On the api side,
`RECOGNITION_CONCURRENCY` (2) bounds concurrent decrypt/crop work and keyframe
FFmpeg runs use `-threads 2`, so indexing load stays inside the pool.
Verify with `docker stats` while an indexing run is active.

## Enabling GPU later (NVIDIA on the Ryzen node)

The app code is already CUDA-ready: `recognition/app/sessions.py` always
requests `CUDAExecutionProvider` first and falls back to CPU. Enabling a GPU
is packaging + Swarm configuration only:

1. **Host setup (manager node):** install the NVIDIA driver and container
   toolkit, then wire it into Docker:
   ```bash
   sudo apt install nvidia-driver-550 nvidia-container-toolkit
   sudo nvidia-ctk runtime configure --runtime=docker
   ```
2. **Advertise the GPU to Swarm** (Swarm has no `--gpus`; it uses generic
   resources). Get the GPU UUID from `nvidia-smi -a | grep UUID` (use the
   short `GPU-xxxxxxxx` prefix), then in `/etc/docker/daemon.json`:
   ```json
   {
     "runtimes": { "nvidia": { "path": "nvidia-container-runtime" } },
     "default-runtime": "nvidia",
     "node-generic-resources": ["NVIDIA-GPU=GPU-xxxxxxxx"]
   }
   ```
   In `/etc/nvidia-container-runtime/config.toml` uncomment:
   ```toml
   swarm-resource = "DOCKER_RESOURCE_GPU"
   ```
   Then `sudo systemctl restart docker`.
3. **Build + push the CUDA image** (CUDA 12 + cuDNN base, `onnxruntime-gpu`):
   ```bash
   docker buildx build --platform linux/amd64 \
     -f recognition/Dockerfile.cuda \
     -t 192.168.68.57:5000/apollo-sfs_recognition:cuda-$(git rev-parse --short HEAD) \
     recognition/ --push
   ```
4. **Reserve the GPU in `docker-stack.yml`** — add to the `recognition`
   service's `deploy` block and point `RECOGNITION_TAG` at the CUDA image:
   ```yaml
   resources:
     reservations:
       generic_resources:
         - discrete_resource_spec:
             kind: "NVIDIA-GPU"
             value: 1
   ```
5. **Verify:** `docker compose exec api wget -qO- http://recognition:8000/healthz`
   (or the Swarm equivalent) should list `CUDAExecutionProvider` in
   `providers`. Keep the CPU limits — they still cap the Python-side pre/post
   processing; GPU inference frees CPU rather than adding to it.

## Operational notes

- **Reindex after model changes:** detections store `model_version`. Old
  detections are not auto-reindexed; purge + re-enable a collection to
  re-run it under new models.
- **Deleting data:** disabling the toggle keeps groups/detections; the
  "also delete recognition data" option removes groups, orphaned detections,
  and crop blobs, and refunds the quota. Deleting a file cascades its
  detections and refunds its crop bytes.
- **Failure visibility:** permanently failed files appear in the status
  counts (`failed`) and as `recognition_job_failed` audit events.
