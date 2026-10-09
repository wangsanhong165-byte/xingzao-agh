"""Extract a high-contrast planar glyph/logo and deterministically widen it."""

from __future__ import annotations

import argparse
import base64
import json
import math
from pathlib import Path

import cv2
import numpy as np


MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_PIXELS = 12_000_000


def _mask_png(mask: np.ndarray) -> str:
    ok, encoded = cv2.imencode(".png", mask.astype(np.uint8) * 255)
    if not ok:
        raise RuntimeError("OpenCV could not encode mask PNG")
    return base64.b64encode(encoded.tobytes()).decode("ascii")


def _contours(mask: np.ndarray) -> list[dict]:
    found, hierarchy = cv2.findContours(mask.copy(), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        return []
    if len(found) > 4096 or sum(len(contour) for contour in found) > 200_000:
        raise ValueError("ROI轮廓过于复杂，请缩小区域或使用更清晰的单色字样/徽标")
    hierarchy = hierarchy[0]
    result = []
    for index, item in enumerate(hierarchy):
        if item[3] != -1:
            continue
        outer = found[index].reshape(-1, 2)
        if len(outer) < 3:
            continue
        holes = []
        child = int(item[2])
        while child != -1:
            hole = found[child].reshape(-1, 2)
            if len(hole) >= 3:
                holes.append([[int(x), int(y)] for x, y in hole])
            child = int(hierarchy[child][0])
        result.append({"outer": [[int(x), int(y)] for x, y in outer], "holes": holes})
    return result


def _topology(mask: np.ndarray) -> tuple[int, int]:
    contours, hierarchy = cv2.findContours(mask.copy(), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        return 0, 0
    hierarchy = hierarchy[0]
    return sum(item[3] == -1 for item in hierarchy), sum(item[3] != -1 for item in hierarchy)


def _threshold_foreground(crop: np.ndarray) -> np.ndarray:
    if crop.ndim == 2:
        gray = crop
    elif crop.shape[2] == 4:
        bgr = crop[:, :, :3].astype(np.float32)
        alpha = crop[:, :, 3:4].astype(np.float32) / 255.0
        composited = (bgr * alpha + 255.0 * (1.0 - alpha)).astype(np.uint8)
        gray = cv2.cvtColor(composited, cv2.COLOR_BGR2GRAY)
    else:
        gray = cv2.cvtColor(crop[:, :, :3], cv2.COLOR_BGR2GRAY)
    border = np.concatenate((gray[0, :], gray[-1, :], gray[:, 0], gray[:, -1]))
    border_median = float(np.median(border))
    threshold, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    if border_median >= threshold:
        return (gray <= threshold).astype(np.uint8)
    return (gray >= threshold).astype(np.uint8)


def extract_detail(
    image_bytes: bytes,
    width_mm: float,
    depth_mm: float,
    min_width_mm: float,
    roi: tuple[int, int, int, int] | None = None,
    min_fidelity: float = 0.75,
) -> dict:
    if not isinstance(image_bytes, (bytes, bytearray)) or not image_bytes or len(image_bytes) > MAX_IMAGE_BYTES:
        raise ValueError("图像必须是非空PNG且不超过5MiB")
    for value, label in ((width_mm, "width"), (depth_mm, "depth")):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 1 <= value <= 180:
            raise ValueError(f"{label}尺寸必须在1～180mm范围内")
    if isinstance(min_width_mm, bool) or not isinstance(min_width_mm, (int, float)) or not math.isfinite(min_width_mm) or not 0.4 <= min_width_mm <= 3:
        raise ValueError("minFeatureWidth必须在0.4～3mm范围内")
    if isinstance(min_fidelity, bool) or not isinstance(min_fidelity, (int, float)) or not math.isfinite(min_fidelity) or not 0 <= min_fidelity <= 1:
        raise ValueError("minFidelity必须在0～1范围内")
    if min_width_mm >= min(width_mm, depth_mm):
        raise ValueError("minFeatureWidth必须小于标牌宽度和深度")

    encoded = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(encoded, cv2.IMREAD_UNCHANGED)
    if image is None:
        raise ValueError("无法解码PNG图像")
    image_height, image_width = image.shape[:2]
    if image_width * image_height > MAX_PIXELS:
        raise ValueError("解码图像不能超过1200万像素")
    if roi is None:
        roi = (0, 0, image_width, image_height)
    if not isinstance(roi, (tuple, list)) or len(roi) != 4 or any(isinstance(v, bool) or not isinstance(v, int) for v in roi):
        raise ValueError("ROI必须是整数[x,y,width,height]")
    x, y, roi_width, roi_height = roi
    if x < 0 or y < 0 or roi_width <= 0 or roi_height <= 0 or x + roi_width > image_width or y + roi_height > image_height:
        raise ValueError("ROI超出图像范围或为空")

    roi_target = _threshold_foreground(image[y : y + roi_height, x : x + roi_width])
    roi_target = cv2.morphologyEx(roi_target, cv2.MORPH_CLOSE, np.ones((3, 3), dtype=np.uint8))
    if not np.any(roi_target):
        raise ValueError("ROI中没有可提取的前景字样或徽标")
    foreground_touches_roi_edge = bool(
        np.any(roi_target[0, :]) or np.any(roi_target[-1, :])
        or np.any(roi_target[:, 0]) or np.any(roi_target[:, -1])
    )

    # ROI chooses which pixels may become relief; it does not redefine the
    # plate coordinate system. Keep the crop in its original full-image place.
    target_source = np.zeros((image_height, image_width), dtype=np.uint8)
    roi_source_mask = np.zeros((image_height, image_width), dtype=np.uint8)
    target_source[y : y + roi_height, x : x + roi_width] = roi_target
    roi_source_mask[y : y + roi_height, x : x + roi_width] = 1

    # Raster resolution follows the requested physical feature scale instead of
    # the upload resolution. This keeps morphology bounded on 12MP inputs.
    pixels_per_mm = max(2.0, min(16.0, 8.0 / min_width_mm))
    work_width = min(image_width, max(1, int(round(width_mm * pixels_per_mm))))
    work_height = min(image_height, max(1, int(round(depth_mm * pixels_per_mm))))
    max_work_pixels = 3_000_000
    if work_width * work_height > max_work_pixels:
        scale = math.sqrt(max_work_pixels / (work_width * work_height))
        work_width = max(1, int(math.floor(work_width * scale)))
        work_height = max(1, int(math.floor(work_height * scale)))
    if target_source.shape[1] != work_width or target_source.shape[0] != work_height:
        target = cv2.resize(target_source, (work_width, work_height), interpolation=cv2.INTER_NEAREST)
        roi_work_mask = cv2.resize(roi_source_mask, (work_width, work_height), interpolation=cv2.INTER_NEAREST)
    else:
        target = target_source
        roi_work_mask = roi_source_mask

    # Use an elliptical kernel sized in millimetres, accounting for separate
    # X/Y pixel scales. Closing joins sub-minimum gaps. A distance-transform
    # ridge approximates each stroke centerline; dilating that ridge only adds
    # material where a stroke is narrower than the requested feature width.
    step_x = width_mm / work_width
    step_y = depth_mm / work_height
    radius_x = max(1, int(math.ceil((min_width_mm * 0.5) / step_x)))
    radius_y = max(1, int(math.ceil((min_width_mm * 0.5) / step_y)))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius_x * 2 + 1, radius_y * 2 + 1))
    enhanced = cv2.morphologyEx(target, cv2.MORPH_CLOSE, kernel)
    distances = cv2.distanceTransform(enhanced, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    local_maximum = cv2.dilate(distances, np.ones((3, 3), dtype=np.uint8))
    ridge = ((enhanced != 0) & (distances > 0) & (distances >= local_maximum - 1e-6)).astype(np.uint8)
    enhanced = cv2.bitwise_or(enhanced, cv2.dilate(ridge, kernel, iterations=1))
    enhanced = (enhanced != 0).astype(np.uint8)
    # Morphology must not silently alter pixels outside the user-selected ROI.
    enhanced = cv2.bitwise_and(enhanced, roi_work_mask.astype(np.uint8))

    component_count, _, _, _ = cv2.connectedComponentsWithStats(enhanced, 8)
    if component_count > 1025:
        raise ValueError("增强轮廓包含过多离散组件，请裁剪ROI或移除背景噪点")

    target_area = int(np.count_nonzero(target))
    enhanced_area = int(np.count_nonzero(enhanced))
    intersection = int(np.count_nonzero(target & enhanced))
    union_area = int(np.count_nonzero(target | enhanced))
    fidelity = intersection / union_area if union_area else 1.0
    target_components, target_holes = _topology(target)
    enhanced_components, enhanced_holes = _topology(enhanced)
    topology_preserved = target_components == enhanced_components and target_holes == enhanced_holes
    contours = _contours(enhanced)
    target_contours = _contours(target)
    if not contours:
        raise ValueError("细节增强后没有可构造的闭合轮廓")
    ys, xs = np.where(enhanced != 0)
    feature_bounds = [
        (float(xs.min()) / work_width - 0.5) * width_mm,
        (0.5 - float(ys.max() + 1) / work_height) * depth_mm,
        (float(xs.max() + 1) / work_width - 0.5) * width_mm,
        (0.5 - float(ys.min()) / work_height) * depth_mm,
    ]
    warnings = []
    if foreground_touches_roi_edge:
        warnings.append("前景接触ROI边缘；增强结果被限制在ROI内，该边缘无法保证达到最小宽度，请扩大ROI")
    if not topology_preserved:
        warnings.append(f"最小宽度形态学处理改变轮廓拓扑（组件{target_components}→{enhanced_components}，孔洞{target_holes}→{enhanced_holes}）")
    if fidelity < min_fidelity:
        warnings.append(f"细节保真IoU {fidelity:.3f}低于要求{min_fidelity:.3f}，请放大标牌或降低最小特征宽度")
    if enhanced_area <= target_area:
        warnings.append("形态学增强没有增加前景面积，可能未形成预期的最小宽度浮雕")
    return {
        "contours": contours,
        "targetContours": target_contours,
        "targetMask": {"width": work_width, "height": work_height, "dataBase64": _mask_png(target)},
        "enhancedMask": {"width": work_width, "height": work_height, "dataBase64": _mask_png(enhanced)},
        "sourceRoiSize": [roi_width, roi_height],
        "fidelity": round(float(fidelity), 6),
        "minWidthMm": float(min_width_mm),
        "minWidthIsTarget": True,
        "minWidthMeaning": "形态学处理的目标最小特征宽度设定值，不是结果实际最窄特征的精确测量或保证",
        "minimumWidthMethod": "physical-scale elliptical closing plus dilation from a distance-transform ridge",
        "minimumWidthKernelPixels": [radius_x * 2 + 1, radius_y * 2 + 1],
        "topologyPreserved": bool(topology_preserved),
        "targetTopology": {"components": int(target_components), "holes": int(target_holes)},
        "enhancedTopology": {"components": int(enhanced_components), "holes": int(enhanced_holes)},
        "targetAreaPixels": target_area,
        "enhancedAreaPixels": enhanced_area,
        "featureBoundsMm": [round(v, 6) for v in feature_bounds],
        "warnings": warnings,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract and widen a planar PNG glyph/logo for FDM relief.")
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--width-mm", type=float, required=True)
    parser.add_argument("--depth-mm", type=float, required=True)
    parser.add_argument("--min-width-mm", type=float, required=True)
    parser.add_argument("--roi", type=str, required=True, help="x,y,width,height pixel rectangle")
    parser.add_argument("--min-fidelity", type=float, default=0.75)
    args = parser.parse_args()
    try:
        roi = tuple(int(value) for value in args.roi.split(","))
    except ValueError as error:
        raise ValueError("ROI格式应为x,y,width,height") from error
    result = extract_detail(args.image.read_bytes(), args.width_mm, args.depth_mm, args.min_width_mm, roi, args.min_fidelity)
    encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    else:
        print(encoded)


if __name__ == "__main__":
    main()
