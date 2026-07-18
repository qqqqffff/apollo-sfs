# CPU image (ships today). Works on amd64 (prod Ryzen node) and arm64 (dev
# Pi) — onnxruntime publishes wheels for both. The app always requests the
# CUDA execution provider first and falls back to CPU, so switching to
# Dockerfile.cuda later requires no code changes.
FROM python:3.12-slim

# opencv-python-headless needs glib at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bake the models into the image so prod deploys are self-contained (no
# network dependency at container start). MODEL_DIR can still be overridden
# with a volume mount for dev iteration.
COPY download_models.py .
RUN MODEL_DIR=/srv/models python download_models.py

COPY app ./app

RUN useradd --uid 65532 --no-create-home nonroot
USER 65532

ENV MODEL_DIR=/srv/models
EXPOSE 8000

# Single worker: ONNX Runtime parallelizes within a request (intra-op threads
# capped to half the cores) and the Go API bounds in-flight requests.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
