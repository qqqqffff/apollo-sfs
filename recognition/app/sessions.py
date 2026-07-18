"""ONNX Runtime session factory.

Always requests CUDAExecutionProvider first with CPUExecutionProvider as the
fallback: on the CPU-only image ORT logs a warning and silently uses CPU; on
the CUDA image (Dockerfile.cuda + onnxruntime-gpu + an NVIDIA GPU advertised
to the container) the same code runs accelerated with zero changes.
"""

import logging
import os

from . import config

log = logging.getLogger("recognition")

PROVIDERS = ["CUDAExecutionProvider", "CPUExecutionProvider"]


def intra_op_threads() -> int:
    if config.ORT_INTRA_OP_THREADS > 0:
        return config.ORT_INTRA_OP_THREADS
    return max(1, (os.cpu_count() or 2) // 2)


def create_session(model_path: str):
    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = intra_op_threads()
    opts.log_severity_level = 3
    available = ort.get_available_providers()
    providers = [p for p in PROVIDERS if p in available] or ["CPUExecutionProvider"]
    session = ort.InferenceSession(model_path, sess_options=opts, providers=providers)
    log.info("loaded %s providers=%s", os.path.basename(model_path), session.get_providers())
    return session


def active_providers() -> list[str]:
    try:
        import onnxruntime as ort
    except ImportError:  # unit tests without the ORT wheel installed
        return []
    return ort.get_available_providers()
