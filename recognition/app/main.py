"""Recognition sidecar: stateless internal inference service for Apollo SFS.

The Go API decrypts media server-side and POSTs plaintext image bytes here;
this service never touches the DB, MinIO, or any encryption keys. It is only
reachable on the app-network overlay (no published ports, never proxied).
"""

import io
import logging
import os

import numpy as np
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps

from . import config, schemas, sessions, versions
from .auth import require_internal_token

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("recognition")

Image.MAX_IMAGE_PIXELS = config.MAX_PIXELS

app = FastAPI(title="apollo-sfs-recognition", docs_url=None, redoc_url=None)


@app.on_event("startup")
def load_pipelines() -> None:
    # No-op when pipelines are already installed (tests set fakes on
    # app.state before startup). Imported here so tests never pull in model
    # files or ONNX Runtime sessions.
    if getattr(app.state, "face", None) is not None:
        return
    from .pipelines.face import FacePipeline
    from .pipelines.objects import ObjectPipeline
    from .pipelines.pet import PetPipeline

    model_dir = os.path.abspath(config.MODEL_DIR)
    app.state.face = FacePipeline(model_dir)
    app.state.objects = ObjectPipeline(model_dir)
    app.state.pet = PetPipeline(model_dir)
    log.info("pipelines ready model_dir=%s providers=%s", model_dir, sessions.active_providers())


@app.get("/healthz")
def healthz(request: Request) -> dict:
    return {
        "status": "ok" if getattr(request.app.state, "face", None) is not None else "loading",
        "providers": sessions.active_providers(),
        "models": versions.ALL,
    }


@app.post("/v1/analyze", dependencies=[Depends(require_internal_token)])
async def analyze(request: Request) -> JSONResponse:
    raw = await request.body()
    if not raw:
        raise HTTPException(status_code=400, detail="empty body")

    try:
        img = Image.open(io.BytesIO(raw))
        img = ImageOps.exif_transpose(img)
        rgb = np.asarray(img.convert("RGB"))
    except Image.DecompressionBombError:
        raise HTTPException(status_code=413, detail="image too large")
    except Exception:
        raise HTTPException(status_code=422, detail="undecodable image")

    state = request.app.state
    object_dets = state.objects.analyze(rgb)
    pets = state.pet.analyze(rgb, object_dets)
    faces = state.face.analyze(rgb)

    # person is represented by face groups and cat/dog by pet groups — keep
    # them out of the generic object results.
    objects = [d for d in object_dets if d["class"] not in ("person", "cat", "dog")]

    resp = schemas.AnalyzeResponse(
        faces=[schemas.FaceDetection(**f) for f in faces],
        pets=[schemas.PetDetection(cls=p["class"], bbox=p["bbox"],
                                   confidence=p["confidence"], embedding=p["embedding"]) for p in pets],
        objects=[schemas.ObjectDetection(cls=o["class"], bbox=o["bbox"],
                                         confidence=o["confidence"]) for o in objects],
        model_versions=versions.ALL,
    )
    return JSONResponse(resp.model_dump(by_alias=True))
