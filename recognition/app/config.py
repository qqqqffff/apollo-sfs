"""Environment-driven configuration for the recognition sidecar."""

import os


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


# Shared secret checked against the X-Internal-Token request header. The Go
# API is the only client; requests without the token are rejected.
TOKEN = os.environ.get("RECOGNITION_TOKEN", "")

# Directory holding the .onnx model files (baked into the image at build time
# by download_models.py; overridable for dev volume mounts).
MODEL_DIR = os.environ.get("MODEL_DIR", os.path.join(os.path.dirname(__file__), "..", "models"))

# ONNX Runtime intra-op thread cap. 0 lets sessions.py derive half the visible
# cores, matching the container CPU limit guidance (50% resource pool).
ORT_INTRA_OP_THREADS = _int_env("ORT_INTRA_OP_THREADS", 0)

# Reject images larger than this many pixels before decode (decompression-bomb
# guard; the Go API already restricts callers to media mime types).
MAX_PIXELS = _int_env("MAX_PIXELS", 50_000_000)

# Minimum detector confidences. Face minimum size guards against clustering
# unusable low-res faces.
FACE_SCORE_THRESHOLD = _float_env("FACE_SCORE_THRESHOLD", 0.6)
FACE_MIN_SIZE_PX = _int_env("FACE_MIN_SIZE_PX", 40)
OBJECT_SCORE_THRESHOLD = _float_env("OBJECT_SCORE_THRESHOLD", 0.5)
OBJECT_NMS_THRESHOLD = _float_env("OBJECT_NMS_THRESHOLD", 0.45)
