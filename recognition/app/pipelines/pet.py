"""Pet pipeline: crop cat/dog detections (from the object pipeline) and embed
each crop with the OpenCLIP ViT-B/32 image encoder (512-d). The Go API
clusters these embeddings per species with a strict threshold to separate
individual pets; over-splitting is corrected by the merge UI."""

import os

import cv2
import numpy as np

from .. import sessions

from ..versions import PET as MODEL_VERSION
PET_CLASSES = ("cat", "dog")
CROP_MARGIN = 0.2

_CLIP_MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
_CLIP_STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)


class PetPipeline:
    def __init__(self, model_dir: str):
        self._session = sessions.create_session(os.path.join(model_dir, "clip_vit_b32_vision.onnx"))
        self._input = self._session.get_inputs()[0].name

    def analyze(self, rgb: np.ndarray, object_detections: list[dict]) -> list[dict]:
        """Takes the full-frame RGB image and the object pipeline's raw output;
        returns cat/dog detections with embeddings added."""
        h, w = rgb.shape[:2]
        out = []
        for det in object_detections:
            if det["class"] not in PET_CLASSES:
                continue
            crop = _crop_with_margin(rgb, det["bbox"], w, h)
            if crop.size == 0:
                continue
            out.append({
                "class": det["class"],
                "bbox": det["bbox"],
                "confidence": det["confidence"],
                "embedding": self._embed(crop),
            })
        return out

    def _embed(self, crop_rgb: np.ndarray) -> list[float]:
        blob = _clip_preprocess(crop_rgb)
        vec = self._session.run(None, {self._input: blob})[0][0].astype(np.float32)
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec = vec / norm
        return vec.tolist()


def _crop_with_margin(rgb: np.ndarray, bbox: list[float], w: int, h: int) -> np.ndarray:
    x, y, bw, bh = bbox
    mx, my = bw * CROP_MARGIN, bh * CROP_MARGIN
    x1 = int(max(0.0, (x - mx)) * w)
    y1 = int(max(0.0, (y - my)) * h)
    x2 = int(min(1.0, (x + bw + mx)) * w)
    y2 = int(min(1.0, (y + bh + my)) * h)
    return rgb[y1:y2, x1:x2]


def _clip_preprocess(rgb: np.ndarray) -> np.ndarray:
    """Resize shorter side to 224 (bicubic), center-crop 224, normalize."""
    h, w = rgb.shape[:2]
    scale = 224 / min(h, w)
    resized = cv2.resize(rgb, (max(224, round(w * scale)), max(224, round(h * scale))),
                         interpolation=cv2.INTER_CUBIC)
    rh, rw = resized.shape[:2]
    top, left = (rh - 224) // 2, (rw - 224) // 2
    cropped = resized[top:top + 224, left:left + 224]
    arr = cropped.astype(np.float32) / 255.0
    arr = (arr - _CLIP_MEAN) / _CLIP_STD
    return arr.transpose(2, 0, 1)[None]
