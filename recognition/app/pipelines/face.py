"""Face pipeline: YuNet detection (via OpenCV FaceDetectorYN) + ArcFace-style
512-d embeddings (AuraFace-v1). Both models are permissively licensed —
see docs/ai_recognition_setup.md for the license table."""

import os

import cv2
import numpy as np

from .. import config, sessions

from ..versions import FACE as MODEL_VERSION

# Canonical ArcFace 112x112 5-point landmark template (left eye, right eye,
# nose, left mouth corner, right mouth corner).
_ARCFACE_TEMPLATE = np.array(
    [
        [38.2946, 51.6963],
        [73.5318, 51.5014],
        [56.0252, 71.7366],
        [41.5493, 92.3655],
        [70.7299, 92.2041],
    ],
    dtype=np.float32,
)


class FacePipeline:
    def __init__(self, model_dir: str):
        self._detector_path = os.path.join(model_dir, "face_detection_yunet_2023mar.onnx")
        # FaceDetectorYN input size is set per image in detect().
        self._detector = cv2.FaceDetectorYN.create(
            self._detector_path, "", (320, 320),
            score_threshold=config.FACE_SCORE_THRESHOLD,
            nms_threshold=0.3,
        )
        self._embedder = sessions.create_session(os.path.join(model_dir, "auraface_glintr100.onnx"))
        self._embed_input = self._embedder.get_inputs()[0].name

    def analyze(self, rgb: np.ndarray) -> list[dict]:
        """rgb: HxWx3 uint8, EXIF-oriented. Returns dicts with normalized bbox,
        confidence, and unit-normalized 512-d embedding."""
        h, w = rgb.shape[:2]
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        self._detector.setInputSize((w, h))
        _, faces = self._detector.detect(bgr)
        if faces is None:
            return []

        out = []
        for f in faces:
            x, y, bw, bh = f[0], f[1], f[2], f[3]
            if min(bw, bh) < config.FACE_MIN_SIZE_PX:
                continue
            landmarks = f[4:14].reshape(5, 2).astype(np.float32)
            aligned = self._align(rgb, landmarks)
            emb = self._embed(aligned)
            out.append({
                "bbox": _norm_bbox(x, y, bw, bh, w, h),
                "confidence": float(f[14]),
                "embedding": emb,
            })
        return out

    def _align(self, rgb: np.ndarray, landmarks: np.ndarray) -> np.ndarray:
        m, _ = cv2.estimateAffinePartial2D(landmarks, _ARCFACE_TEMPLATE, method=cv2.LMEDS)
        if m is None:
            m = np.array([[1, 0, 0], [0, 1, 0]], dtype=np.float32)
        return cv2.warpAffine(rgb, m, (112, 112), borderValue=0)

    def _embed(self, aligned_rgb: np.ndarray) -> list[float]:
        blob = (aligned_rgb.astype(np.float32) - 127.5) / 127.5
        blob = blob.transpose(2, 0, 1)[None]
        vec = self._embedder.run(None, {self._embed_input: blob})[0][0].astype(np.float32)
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec = vec / norm
        return vec.tolist()


def _norm_bbox(x: float, y: float, bw: float, bh: float, w: int, h: int) -> list[float]:
    return [
        max(0.0, min(1.0, float(x) / w)),
        max(0.0, min(1.0, float(y) / h)),
        max(0.0, min(1.0, float(bw) / w)),
        max(0.0, min(1.0, float(bh) / h)),
    ]
