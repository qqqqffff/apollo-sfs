"""Model version strings, kept dependency-free so main.py and the tests can
import them without pulling in ONNX Runtime / OpenCV."""

FACE = "yunet-2023mar+auraface-v1"
OBJECT = "yolox-s"
PET = "clip-vit-b32"

ALL = {"face": FACE, "object": OBJECT, "pet": PET}
