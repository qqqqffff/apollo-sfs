"""Shared-secret auth dependency (mirrors the node-metrics-ingest pattern)."""

import hmac

from fastapi import Header, HTTPException

from . import config


def require_internal_token(x_internal_token: str = Header(default="")) -> None:
    if not config.TOKEN:
        raise HTTPException(status_code=503, detail="RECOGNITION_TOKEN not configured")
    if not hmac.compare_digest(x_internal_token, config.TOKEN):
        raise HTTPException(status_code=403, detail="invalid token")
