"""Classical OpenCV measurement for a dark rectangular plate on a light field.

This program deliberately does not use a learned model. It supports only a
near top-down, high-contrast photo of one dark, flat rectangular part on a
plain white or light background. Reported geometry is approximate.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

import cv2
import numpy as np


MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_PIXELS = 12_000_000
WARNINGS = [
    "厚度由用户人工提供；系统无法从单张正俯拍照片推断厚度。",
    "仅适用于白色或浅色、均匀背景上的深色平板零件近正俯拍照片。",
    "照片未做透视校正；斜拍、透视变形或明显镜头畸变会导致尺寸偏差。",
    "本结果是普通图像几何近似，不是AI识图，也不是精密测量。请检查标注图与测量值。",
]


class MeasureError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def fail(code: str, message: str) -> None:
    raise MeasureError(code, message)


def _positive_finite(value: float, label: str) -> float:
    if not math.isfinite(value) or value <= 0:
        fail("INVALID_MEASUREMENT", f"{label} must be a finite positive number")
    return float(value)


def _load_image(path: Path) -> np.ndarray:
    try:
        size = path.stat().st_size
    except OSError:
        fail("IMAGE_READ_FAILED", "Could not read the input image")
    if size <= 0:
        fail("DECODE_FAILED", "Input image is empty")
    if size > MAX_FILE_BYTES:
        fail("IMAGE_TOO_LARGE", "Image file must be no larger than 5 MB")
    try:
        data = np.fromfile(str(path), dtype=np.uint8)
        image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    except (OSError, cv2.error, ValueError):
        image = None
    if image is None or image.ndim != 3:
        fail("DECODE_FAILED", "Input file is not a supported color image")
    height, width = image.shape[:2]
    if width <= 0 or height <= 0 or width * height > MAX_PIXELS:
        fail("IMAGE_TOO_LARGE", "Decoded image must contain no more than 12 million pixels")
    return image


def _segment_one_part(gray: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    height, width = gray.shape
    border = max(3, min(20, round(min(width, height) * 0.035)))
    edge_pixels = np.concatenate(
        [gray[:border, :].ravel(), gray[-border:, :].ravel(), gray[:, :border].ravel(), gray[:, -border:].ravel()]
    )
    background = float(np.median(edge_pixels))
    dark_tail = float(np.percentile(gray, 0.1))
    contrast = background - dark_tail
    if background < 175 or contrast < 45 or dark_tail > 145:
        fail("LOW_CONTRAST", "需要浅色均匀背景和明显更深的零件；当前黑白对比不足。")

    # Midpoint threshold bounded for a bright background; this resists minor
    # exposure shifts without treating ordinary light gray backgrounds as parts.
    threshold = int(max(0, min(185, round((background + dark_tail) / 2))))
    raw = cv2.threshold(gray, threshold, 255, cv2.THRESH_BINARY_INV)[1]
    raw = cv2.morphologyEx(raw, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    raw = cv2.morphologyEx(raw, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))

    count, labels, stats, _ = cv2.connectedComponentsWithStats(raw, connectivity=8)
    components = [(int(stats[i, cv2.CC_STAT_AREA]), i) for i in range(1, count)]
    if not components:
        fail("NO_OBJECT", "未找到足够大的深色零件。")
    components.sort(reverse=True)
    main_area, main_label = components[0]
    if main_area < max(800, int(width * height * 0.008)):
        fail("OBJECT_TOO_SMALL", "零件在照片中太小，无法可靠测量。")
    if main_area > int(width * height * 0.90):
        fail("OBJECT_TOO_LARGE", "深色区域占据过多画面，请让浅色背景完整包围零件。")
    ambiguous = [area for area, _ in components[1:] if area >= max(500, int(main_area * 0.015))]
    if ambiguous:
        fail("MULTIPLE_OBJECTS", "发现多个较大的深色连通区域；请只拍摄一个零件并移除背景杂物。")

    mask = np.zeros_like(raw)
    mask[labels == main_label] = 255
    contours, hierarchy = cv2.findContours(mask, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    if not contours or hierarchy is None:
        fail("NO_OBJECT", "未找到零件外轮廓。")
    root_indices = [i for i, rel in enumerate(hierarchy[0]) if rel[3] == -1]
    if not root_indices:
        fail("NO_OBJECT", "未找到零件外轮廓。")
    outer_index = max(root_indices, key=lambda i: cv2.contourArea(contours[i]))
    outer = contours[outer_index]
    x, y, box_w, box_h = cv2.boundingRect(outer)
    if x <= 1 or y <= 1 or x + box_w >= width - 1 or y + box_h >= height - 1:
        fail("OBJECT_TOUCHES_EDGE", "零件接触照片边缘；请留出完整浅色背景后重拍。")
    if min(box_w, box_h) < 30 or cv2.contourArea(outer) < 700:
        fail("OBJECT_TOO_SMALL", "零件在照片中太小，无法可靠测量。")

    rect = cv2.minAreaRect(outer)
    rect_width, rect_height = map(float, rect[1])
    if min(rect_width, rect_height) < 30:
        fail("OBJECT_TOO_SMALL", "零件在照片中太小，无法可靠测量。")
    rect_area = rect_width * rect_height
    contour_area = float(cv2.contourArea(outer))
    rectangle_fill = contour_area / max(rect_area, 1.0)
    hull_area = float(cv2.contourArea(cv2.convexHull(outer)))
    convexity = contour_area / max(hull_area, 1.0)
    if rectangle_fill <= 0.85 or convexity <= 0.94:
        fail("NON_RECTANGULAR_OUTLINE", "外轮廓不像完整矩形平板；请提供补充信息或更清晰照片。")

    return mask, outer


def _measure(image: np.ndarray, width_mm: float, thickness_mm: float, overlay_path: Path) -> dict[str, Any]:
    known_width = _positive_finite(width_mm, "width-mm")
    thickness = _positive_finite(thickness_mm, "thickness-mm")
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    mask, outer = _segment_one_part(gray)
    rect = cv2.minAreaRect(outer)
    (cx, cy), (dim_a, dim_b), _ = rect
    box = cv2.boxPoints(rect).astype(np.float64)
    edge_vectors = [box[(i + 1) % 4] - box[i] for i in range(4)]
    long_edge = max(edge_vectors, key=lambda vector: float(np.linalg.norm(vector)))
    pixel_width = float(np.linalg.norm(long_edge))
    pixel_depth = float(min(dim_a, dim_b))
    if pixel_width < pixel_depth:
        pixel_width, pixel_depth = pixel_depth, pixel_width
    ux, uy = (long_edge / max(float(np.linalg.norm(long_edge)), 1e-12)).tolist()
    if ux < -1e-6 or (abs(ux) <= 1e-6 and uy < 0):
        ux, uy = -ux, -uy
    # The perpendicular axis is deterministic for a given photographed pose;
    # the image's downward screen direction defines positive local Y.
    vx, vy = -uy, ux
    if pixel_width <= 0 or pixel_depth <= 0:
        fail("INVALID_GEOMETRY", "Could not estimate the rectangular dimensions")
    mm_per_pixel = known_width / pixel_width
    measured_width = known_width
    measured_depth = pixel_depth * mm_per_pixel
    center = np.array([cx, cy], dtype=np.float64)

    holes: list[dict[str, float]] = []
    ignored_tiny = 0
    # Inspect only holes directly contained by the selected outside contour.
    contours, found_hierarchy = cv2.findContours(mask, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    if found_hierarchy is not None:
        hierarchy = found_hierarchy[0]
        outer_index = max((i for i, rel in enumerate(hierarchy) if rel[3] == -1), key=lambda i: cv2.contourArea(contours[i]))
        for i, rel in enumerate(hierarchy):
            if int(rel[3]) != outer_index:
                continue
            hole_contour = contours[i]
            area = float(cv2.contourArea(hole_contour))
            if area <= 0:
                continue
            equivalent_radius = math.sqrt(area / math.pi)
            if equivalent_radius < 3.0:
                ignored_tiny += 1
                continue
            perimeter = float(cv2.arcLength(hole_contour, True))
            circularity = 4 * math.pi * area / max(perimeter * perimeter, 1e-9)
            if circularity < 0.75:
                fail("NON_CIRCULAR_HOLE", "发现非圆形开口；不会将它当成圆孔，请补充几何信息或重拍。")
            if len(holes) >= 16:
                fail("TOO_MANY_HOLES", "圆孔超过16个，当前照片测量不支持这么多孔。")
            moments = cv2.moments(hole_contour)
            if abs(moments["m00"]) < 1e-9:
                continue
            hole_center = np.array([moments["m10"] / moments["m00"], moments["m01"] / moments["m00"]])
            delta = hole_center - center
            local_x = float(np.dot(delta, [ux, uy]) * mm_per_pixel)
            local_y = float(np.dot(delta, [vx, vy]) * mm_per_pixel)
            diameter = 2 * equivalent_radius * mm_per_pixel
            holes.append({"x": round(local_x, 3), "y": round(local_y, 3), "diameter": round(diameter, 3)})

    if ignored_tiny:
        tiny_warning = f"忽略了 {ignored_tiny} 个小于3像素半径的微小连通污染。"
    else:
        tiny_warning = None
    holes.sort(key=lambda hole: (hole["x"], hole["y"]))
    dimensions = {
        "width": round(measured_width, 3),
        "depth": round(measured_depth, 3),
        "height": round(thickness, 3),
        "wallThickness": 3,
    }

    annotated = image.copy()
    cv2.drawContours(annotated, [outer], -1, (0, 180, 0), 3)
    for hole in holes:
        image_center = center + (hole["x"] / mm_per_pixel) * np.array([ux, uy]) + (hole["y"] / mm_per_pixel) * np.array([vx, vy])
        point = tuple(np.round(image_center).astype(int).tolist())
        radius = max(3, round((hole["diameter"] / mm_per_pixel) / 2))
        cv2.circle(annotated, point, radius, (0, 80, 255), 2)
        cv2.putText(annotated, f"D{hole['diameter']:.1f}", (point[0] + radius + 4, point[1]), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 60, 220), 1, cv2.LINE_AA)
    overlay_path.parent.mkdir(parents=True, exist_ok=True)
    encoded_ok, encoded_overlay = cv2.imencode('.png', annotated)
    if not encoded_ok:
        fail("OVERLAY_WRITE_FAILED", "Could not write the measurement overlay")
    try:
        overlay_path.write_bytes(encoded_overlay.tobytes())
    except OSError:
        fail("OVERLAY_WRITE_FAILED", "Could not write the measurement overlay")

    warnings = list(WARNINGS)
    if tiny_warning:
        warnings.append(tiny_warning)
    return {
        "spec": {"name": "Measured plate", "type": "plate", "dimensions": dimensions, "holes": holes},
        "measurements": {
            "longEdgePixels": round(pixel_width, 3),
            "shortEdgePixels": round(pixel_depth, 3),
            "millimetersPerPixel": round(mm_per_pixel, 6),
            "holeCount": len(holes),
            "coordinateSystem": "Origin at plate center; X follows the long edge toward image-right (or downward when vertical); Y is the image-clockwise perpendicular.",
            "overlayPath": str(overlay_path.resolve()),
        },
        "warnings": warnings,
        "execution": {"mode": "classical-vision"},
    }


class _JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        fail("INVALID_ARGUMENT", message)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = _JsonArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="Input image path")
    parser.add_argument("--width-mm", required=True, type=float, help="Known longest outer edge in mm")
    parser.add_argument("--thickness-mm", required=True, type=float, help="Manually measured plate thickness in mm")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        args = _parse_args(argv)
        image_path = Path(args.image)
        image = _load_image(image_path)
        result = _measure(image, args.width_mm, args.thickness_mm, image_path.parent / "overlay.png")
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except MeasureError as exc:
        print(json.dumps({"error": str(exc), "code": exc.code}, ensure_ascii=False, separators=(",", ":")))
        return 1
    except Exception:
        # Keep stdout machine-readable and avoid leaking arbitrary tracebacks to
        # the service. Diagnostics remain intentionally coarse-grained.
        print(json.dumps({"error": "Unexpected image measurement failure", "code": "INTERNAL_ERROR"}, ensure_ascii=False, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    raise SystemExit(main())
