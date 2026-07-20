"""Endpoint tests with fake pipelines (no model files / ORT sessions needed).

Run from recognition/: RECOGNITION_TOKEN=test python -m pytest tests/
"""

import io
import os

os.environ.setdefault("RECOGNITION_TOKEN", "test-token")

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import config
from app.main import app


class FakeFace:
    def analyze(self, rgb):
        h, w = rgb.shape[:2]
        assert rgb.dtype == np.uint8
        if min(h, w) <= 4:
            return []
        return [{"bbox": [0.1, 0.1, 0.2, 0.2], "confidence": 0.99,
                 "embedding": [1.0] + [0.0] * 511}]


class FakeObjects:
    def analyze(self, rgb):
        return [
            {"class": "car", "bbox": [0.5, 0.5, 0.3, 0.2], "confidence": 0.8},
            {"class": "cat", "bbox": [0.0, 0.0, 0.4, 0.4], "confidence": 0.9},
            {"class": "person", "bbox": [0.2, 0.2, 0.2, 0.5], "confidence": 0.85},
        ]


class FakePet:
    def analyze(self, rgb, object_dets):
        return [{"class": d["class"], "bbox": d["bbox"], "confidence": d["confidence"],
                 "embedding": [0.0] * 511 + [1.0]} for d in object_dets if d["class"] == "cat"]


@pytest.fixture()
def client():
    app.state.face = FakeFace()
    app.state.objects = FakeObjects()
    app.state.pet = FakePet()
    # Fakes are installed before startup, so load_pipelines no-ops and the
    # real models/ORT sessions are never touched.
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c


def _jpeg_bytes(w=32, h=32) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (128, 64, 32)).save(buf, format="JPEG")
    return buf.getvalue()


def test_healthz_no_auth_required(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "providers" in body and "models" in body


def test_analyze_requires_token(client):
    r = client.post("/v1/analyze", content=_jpeg_bytes())
    assert r.status_code == 403
    r = client.post("/v1/analyze", content=_jpeg_bytes(), headers={"X-Internal-Token": "wrong"})
    assert r.status_code == 403


def test_analyze_rejects_empty_and_garbage(client):
    headers = {"X-Internal-Token": config.TOKEN}
    assert client.post("/v1/analyze", content=b"", headers=headers).status_code == 400
    assert client.post("/v1/analyze", content=b"not an image", headers=headers).status_code == 422


def test_analyze_shape_and_filtering(client):
    r = client.post("/v1/analyze", content=_jpeg_bytes(),
                    headers={"X-Internal-Token": config.TOKEN})
    assert r.status_code == 200
    body = r.json()

    assert len(body["faces"]) == 1
    face = body["faces"][0]
    assert len(face["embedding"]) == 512
    assert face["bbox"] == [0.1, 0.1, 0.2, 0.2]

    # cat surfaces as a pet with an embedding, and person/cat are filtered
    # out of the generic objects list.
    assert [p["class"] for p in body["pets"]] == ["cat"]
    assert len(body["pets"][0]["embedding"]) == 512
    assert [o["class"] for o in body["objects"]] == ["car"]

    assert set(body["model_versions"].keys()) == {"face", "object", "pet"}


def test_exif_orientation_applied(client):
    # A 6x3 image with EXIF orientation 6 (rotate 90 CW) decodes as 3x6; the
    # fake face pipeline sees the transposed array (both dims > 4 fails, so no
    # face on the tiny side proves exif_transpose ran before analyze).
    img = Image.new("RGB", (6, 3), (10, 20, 30))
    exif = img.getexif()
    exif[274] = 6  # Orientation tag
    buf = io.BytesIO()
    img.save(buf, format="JPEG", exif=exif)
    r = client.post("/v1/analyze", content=buf.getvalue(),
                    headers={"X-Internal-Token": config.TOKEN})
    assert r.status_code == 200
    assert r.json()["faces"] == []
