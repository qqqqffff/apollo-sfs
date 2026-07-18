"""Response models for /v1/analyze.

bbox is [x, y, w, h] normalized to [0, 1] of the (EXIF-oriented) source image.
Embeddings are unit-normalized float vectors (512-d for both faces and pets).
The endpoint serializes with by_alias=True so `cls` is emitted as "class".
"""

from pydantic import BaseModel, Field


class FaceDetection(BaseModel):
    bbox: list[float]
    confidence: float
    embedding: list[float]


class PetDetection(BaseModel):
    cls: str = Field(serialization_alias="class")
    bbox: list[float]
    confidence: float
    embedding: list[float]


class ObjectDetection(BaseModel):
    cls: str = Field(serialization_alias="class")
    bbox: list[float]
    confidence: float


class AnalyzeResponse(BaseModel):
    faces: list[FaceDetection]
    pets: list[PetDetection]
    objects: list[ObjectDetection]
    model_versions: dict[str, str]
