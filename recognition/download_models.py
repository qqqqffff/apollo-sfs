#!/usr/bin/env python3
"""Download the ONNX models baked into the recognition image.

All models are open-source with permissive licenses (see the table in
docs/ai_recognition_setup.md). Sources are pinned to a revision/tag; each
download's SHA-256 is printed, and verified when a pin is recorded below.

Populate the sha256 pins after the first trusted build:
    python download_models.py            # prints each file's digest
then paste the digests into MODELS and rebuild — subsequent builds fail closed
on any upstream content change.
"""

import hashlib
import os
import shutil
import sys

import requests
from huggingface_hub import hf_hub_download

MODEL_DIR = os.environ.get("MODEL_DIR", os.path.join(os.path.dirname(__file__), "models"))

# (target filename, source, sha256 pin or None)
# source is either ("hf", repo_id, filename_in_repo, revision) or ("url", url).
MODELS = [
    (
        "face_detection_yunet_2023mar.onnx",
        ("url", "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"),
        None,  # MIT — opencv_zoo
    ),
    (
        "auraface_glintr100.onnx",
        ("hf", "fal/AuraFace-v1", "glintr100.onnx", "main"),
        None,  # Apache-2.0 — fal/AuraFace-v1
    ),
    (
        "yolox_s.onnx",
        ("url", "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.onnx"),
        None,  # Apache-2.0 — Megvii YOLOX
    ),
    (
        "clip_vit_b32_vision.onnx",
        ("hf", "Qdrant/clip-ViT-B-32-vision", "model.onnx", "main"),
        None,  # MIT — OpenCLIP export
    ),
]


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(target: str, source: tuple, pin: str | None) -> None:
    dest = os.path.join(MODEL_DIR, target)
    if os.path.exists(dest) and (pin is None or sha256_of(dest) == pin):
        print(f"[skip] {target} already present")
        return

    if source[0] == "hf":
        _, repo_id, filename, revision = source
        cached = hf_hub_download(repo_id=repo_id, filename=filename, revision=revision)
        shutil.copyfile(cached, dest)
    else:
        _, url = source
        with requests.get(url, stream=True, timeout=300) as r:
            r.raise_for_status()
            with open(dest, "wb") as f:
                for chunk in r.iter_content(chunk_size=1 << 20):
                    f.write(chunk)

    digest = sha256_of(dest)
    print(f"[ok]   {target} sha256={digest}")
    if pin is not None and digest != pin:
        os.remove(dest)
        print(f"[FAIL] {target}: digest mismatch (expected {pin})", file=sys.stderr)
        sys.exit(1)


def main() -> None:
    os.makedirs(MODEL_DIR, exist_ok=True)
    for target, source, pin in MODELS:
        fetch(target, source, pin)
    print(f"models ready in {MODEL_DIR}")


if __name__ == "__main__":
    main()
