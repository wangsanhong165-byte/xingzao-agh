"""Deterministic, non-model helpers for the pinned Hunyuan3D multiview runner."""

from __future__ import annotations

import math
import re
from pathlib import Path

import cv2
import numpy as np


MODEL_REPO = "tencent/Hunyuan3D-2mv"
MODEL_REVISION = "3a761b539b29fe4ff64714813aa9560fd66f5de0"
MODEL_SHA256 = "d36f5881bcdc56726b73e517cd444c13c60732431622da7268145355c8d38e9c"
MODEL_SIZE = 4_928_151_562
MODEL_SUBFOLDER = "hunyuan3d-dit-v2-mv"
MAX_IMPORT_BYTES = 25 * 1024 * 1024
MAX_IMPORT_TRIANGLES = 250_000
BOUNDED_TRIANGLE_TARGET = 240_000

USER_SHEET_SIZE = (480, 270)
USER_SHEET_CROPS = {
    "front": (25, 28, 180, 265),
    "left": (187, 28, 327, 265),
    "back": (331, 28, 471, 265),
}


def _bounded_int(value, label: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(f"{label} must be an integer from {low} to {high}")
    return value


def validate_run_options(
    *, steps: int, resolution: int, num_chunks: int, seed: int,
    target_longest_edge_mm: float, run_id: str,
) -> dict:
    steps = _bounded_int(steps, "steps", 5, 50)
    if isinstance(resolution, bool) or not isinstance(resolution, int) or resolution not in (128, 256, 384):
        raise ValueError("resolution must be integer 128, 256, or 384")
    if num_chunks not in (4000, 8000, 20000):
        raise ValueError("num_chunks must be 4000, 8000, or 20000")
    seed = _bounded_int(seed, "seed", 0, (1 << 32) - 1)
    if (
        isinstance(target_longest_edge_mm, bool)
        or not isinstance(target_longest_edge_mm, (int, float))
        or not math.isfinite(target_longest_edge_mm)
        or not 1 <= target_longest_edge_mm <= 180
    ):
        raise ValueError("target_longest_edge_mm must be finite and between 1 and 180")
    if not isinstance(run_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", run_id):
        raise ValueError("run_id must contain only lowercase letters, digits, and hyphens")
    return {
        "numInferenceSteps": steps,
        "octreeResolution": resolution,
        "numChunks": num_chunks,
        "seed": seed,
        "targetLongestEdgeMm": float(target_longest_edge_mm),
        "runId": run_id,
    }


def detect_guide_rows(views: list[np.ndarray], minimum_shared_pixels: int = 65) -> list[int]:
    if not views:
        raise ValueError("at least one view is required")
    if any(not isinstance(view, np.ndarray) or view.ndim != 3 or view.shape[2] != 3 for view in views):
        raise ValueError("all views must be RGB arrays")
    heights = {view.shape[0] for view in views}
    if len(heights) != 1:
        raise ValueError("all views must be RGB arrays with a common height")
    projection = np.zeros(next(iter(heights)), dtype=np.int64)
    for view in views:
        gray = cv2.cvtColor(view, cv2.COLOR_RGB2GRAY)
        chroma = view.max(axis=2).astype(np.int16) - view.min(axis=2).astype(np.int16)
        neutral_gray = (gray >= 180) & (gray < 245) & (chroma <= 25)
        projection += neutral_gray.sum(axis=1)
    return [int(row) for row in np.flatnonzero(projection >= minimum_shared_pixels)]


def clean_view_rgba(rgb: np.ndarray, guide_rows: list[int] | tuple[int, ...] = ()) -> tuple[np.ndarray, dict]:
    """Remove pale border-connected background, shared neutral guide rows, and detached specks.

    Internal enclosed white areas remain opaque so white garments/details are not treated as holes.
    This is a narrow preprocessing rule for high-contrast illustrated views, not general photo matting.
    """
    if not isinstance(rgb, np.ndarray) or rgb.ndim != 3 or rgb.shape[2] != 3 or rgb.dtype != np.uint8:
        raise ValueError("rgb must be an uint8 HxWx3 image")
    height, width = rgb.shape[:2]
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    chroma = rgb.max(axis=2).astype(np.int16) - rgb.min(axis=2).astype(np.int16)
    light_neutral = ((gray >= 205) & (chroma <= 32)).astype(np.uint8)
    component_count, labels, stats, _ = cv2.connectedComponentsWithStats(light_neutral, connectivity=8)
    border_ids = np.unique(np.concatenate((labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1])))
    background_ids = border_ids[border_ids != 0]
    background = np.isin(labels, background_ids)
    alpha = (~background).astype(np.uint8)

    expanded_rows = sorted({
        row + delta for row in guide_rows for delta in (-1, 0, 1)
        if isinstance(row, int) and 0 <= row + delta < height
    })
    if expanded_rows:
        rows = np.asarray(expanded_rows, dtype=np.int32)
        annotation_pixels = (gray[rows] >= 180) & (gray[rows] < 245) & (chroma[rows] <= 25)
        alpha[rows] = np.where(annotation_pixels, 0, alpha[rows])

    count, components, component_stats, _ = cv2.connectedComponentsWithStats(alpha, connectivity=8)
    if count <= 1:
        raise ValueError("preprocessing removed the whole character foreground")
    main_id = 1 + int(np.argmax(component_stats[1:, cv2.CC_STAT_AREA]))
    main = components == main_id
    near_main = cv2.dilate(
        main.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (21, 21))
    ) != 0
    keep = main.copy()
    kept_ids = [main_id]
    removed_ids = []
    for component_id in range(1, count):
        if component_id == main_id:
            continue
        mask = components == component_id
        area = int(component_stats[component_id, cv2.CC_STAT_AREA])
        x, y, comp_width, comp_height, _ = (int(v) for v in component_stats[component_id])
        touches_edge = x == 0 or y == 0 or x + comp_width >= width or y + comp_height >= height
        neutral_ratio = float(
            ((chroma[mask] <= 32) & (gray[mask] >= 180) & (gray[mask] < 245)).sum() / max(area, 1)
        )
        thin_neutral = (
            neutral_ratio > 0.70
            and max(comp_width / max(comp_height, 1), comp_height / max(comp_width, 1)) > 3.0
            and area < 500
        )
        preserve = bool(near_main[mask].any()) and area >= 8 or area >= 250
        if thin_neutral or (touches_edge and area < 250) or not preserve:
            removed_ids.append(component_id)
        else:
            keep |= mask
            kept_ids.append(component_id)

    rgba = np.dstack((rgb, np.where(keep, 255, 0).astype(np.uint8)))
    return rgba, {
        "sizePx": [width, height],
        "borderBackgroundComponents": int(len(background_ids)),
        "guideRowsRelativeToCrop": list(guide_rows),
        "foregroundComponentsBeforeCleanup": int(count - 1),
        "componentsKept": len(kept_ids),
        "removedComponents": len(removed_ids),
        "foregroundPixels": int(keep.sum()),
    }


def compute_yup_to_zup_transform(vertices: np.ndarray, target_longest_edge_mm: float) -> tuple[np.ndarray, dict]:
    vertices = np.asarray(vertices, dtype=np.float64)
    if vertices.ndim != 2 or vertices.shape[1] != 3 or len(vertices) == 0 or not np.isfinite(vertices).all():
        raise ValueError("vertices must be a finite non-empty Nx3 array")
    if (
        isinstance(target_longest_edge_mm, bool)
        or not isinstance(target_longest_edge_mm, (int, float))
        or not math.isfinite(target_longest_edge_mm)
        or not 1 <= target_longest_edge_mm <= 180
    ):
        raise ValueError("target_longest_edge_mm must be finite and between 1 and 180")
    source_bounds = np.stack((vertices.min(axis=0), vertices.max(axis=0)))
    source_extents = source_bounds[1] - source_bounds[0]
    if source_extents[1] <= 0:
        raise ValueError("Y-up source must have positive Y extent")
    rotation = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], dtype=np.float64)
    rotated = vertices @ rotation.T
    rotated_bounds = np.stack((rotated.min(axis=0), rotated.max(axis=0)))
    rotated_extents = rotated_bounds[1] - rotated_bounds[0]
    scale = float(target_longest_edge_mm) / float(rotated_extents.max())
    translation = np.array([
        -(rotated_bounds[0][0] + rotated_bounds[1][0]) * 0.5 * scale,
        -(rotated_bounds[0][1] + rotated_bounds[1][1]) * 0.5 * scale,
        -rotated_bounds[0][2] * scale,
    ], dtype=np.float64)
    matrix = np.eye(4, dtype=np.float64)
    matrix[:3, :3] = scale * rotation
    matrix[:3, 3] = translation
    return matrix, {
        "sourceUpAxis": "Y",
        "sourceExtents": source_extents.tolist(),
        "rotationDegreesX": 90,
        "rotationMatrix": rotation.tolist(),
        "scale": scale,
        "translation": translation.tolist(),
        "targetLongestEdgeMm": float(target_longest_edge_mm),
        "normalizationStrategy": "Y-up to Z-up, uniform scale, center XY, bottom Z=0",
    }


def requires_import_simplification(triangle_count: int, stl_bytes: int) -> bool:
    if isinstance(triangle_count, bool) or not isinstance(triangle_count, int) or triangle_count < 0:
        raise ValueError("triangle_count must be a non-negative integer")
    if isinstance(stl_bytes, bool) or not isinstance(stl_bytes, int) or stl_bytes < 0:
        raise ValueError("stl_bytes must be a non-negative integer")
    return triangle_count > MAX_IMPORT_TRIANGLES or stl_bytes > MAX_IMPORT_BYTES
