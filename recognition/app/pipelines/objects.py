"""Object pipeline: YOLOX-s (Apache-2.0) over the 80 COCO classes.

person/cat/dog are excluded from the object results by the caller: people are
represented by face groups and cats/dogs by individual pet groups.
"""

import os

import cv2
import numpy as np

from .. import config, sessions

from ..versions import OBJECT as MODEL_VERSION
INPUT_SIZE = (640, 640)

COCO_CLASSES = (
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
    "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat",
    "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack",
    "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball",
    "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
    "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
    "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair",
    "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
    "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
    "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier",
    "toothbrush",
)


class ObjectPipeline:
    def __init__(self, model_dir: str):
        self._session = sessions.create_session(os.path.join(model_dir, "yolox_s.onnx"))
        self._input = self._session.get_inputs()[0].name

    def analyze(self, rgb: np.ndarray) -> list[dict]:
        """Returns [{class, bbox (normalized xywh), confidence}] for all COCO
        classes above the score threshold."""
        h, w = rgb.shape[:2]
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        blob, ratio = _preproc(bgr, INPUT_SIZE)
        preds = self._session.run(None, {self._input: blob})[0]
        preds = _decode_outputs(preds[0], INPUT_SIZE)

        boxes_xywh = preds[:, :4]  # center-x, center-y, w, h in input px
        scores = preds[:, 4:5] * preds[:, 5:]
        out = []
        for cls_idx in range(scores.shape[1]):
            cls_scores = scores[:, cls_idx]
            keep_mask = cls_scores >= config.OBJECT_SCORE_THRESHOLD
            if not keep_mask.any():
                continue
            cls_boxes = _cxcywh_to_xyxy(boxes_xywh[keep_mask]) / ratio
            cls_conf = cls_scores[keep_mask]
            for i in _nms(cls_boxes, cls_conf, config.OBJECT_NMS_THRESHOLD):
                x1, y1, x2, y2 = cls_boxes[i]
                x1, y1 = max(0.0, x1), max(0.0, y1)
                x2, y2 = min(float(w), x2), min(float(h), y2)
                if x2 <= x1 or y2 <= y1:
                    continue
                out.append({
                    "class": COCO_CLASSES[cls_idx],
                    "bbox": [x1 / w, y1 / h, (x2 - x1) / w, (y2 - y1) / h],
                    "confidence": float(cls_conf[i]),
                })
        return out


def _preproc(bgr: np.ndarray, input_size: tuple[int, int]) -> tuple[np.ndarray, float]:
    padded = np.full((input_size[0], input_size[1], 3), 114, dtype=np.uint8)
    ratio = min(input_size[0] / bgr.shape[0], input_size[1] / bgr.shape[1])
    resized = cv2.resize(
        bgr,
        (int(bgr.shape[1] * ratio), int(bgr.shape[0] * ratio)),
        interpolation=cv2.INTER_LINEAR,
    )
    padded[: resized.shape[0], : resized.shape[1]] = resized
    blob = padded.transpose(2, 0, 1)[None].astype(np.float32)
    return blob, ratio


def _decode_outputs(preds: np.ndarray, input_size: tuple[int, int], strides=(8, 16, 32)) -> np.ndarray:
    """Standard YOLOX grid decode: raw head outputs -> boxes in input pixels."""
    grids, expanded = [], []
    for stride in strides:
        gh, gw = input_size[0] // stride, input_size[1] // stride
        xv, yv = np.meshgrid(np.arange(gw), np.arange(gh))
        grid = np.stack((xv, yv), 2).reshape(-1, 2)
        grids.append(grid)
        expanded.append(np.full((grid.shape[0], 1), stride))
    grids = np.concatenate(grids, 0)
    expanded = np.concatenate(expanded, 0)
    preds = preds.copy()
    preds[:, :2] = (preds[:, :2] + grids) * expanded
    preds[:, 2:4] = np.exp(preds[:, 2:4]) * expanded
    return preds


def _cxcywh_to_xyxy(boxes: np.ndarray) -> np.ndarray:
    out = np.empty_like(boxes)
    out[:, 0] = boxes[:, 0] - boxes[:, 2] / 2
    out[:, 1] = boxes[:, 1] - boxes[:, 3] / 2
    out[:, 2] = boxes[:, 0] + boxes[:, 2] / 2
    out[:, 3] = boxes[:, 1] + boxes[:, 3] / 2
    return out


def _nms(boxes: np.ndarray, scores: np.ndarray, iou_threshold: float) -> list[int]:
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(int(i))
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0.0, xx2 - xx1) * np.maximum(0.0, yy2 - yy1)
        iou = inter / (areas[i] + areas[order[1:]] - inter + 1e-9)
        order = order[1:][iou <= iou_threshold]
    return keep
