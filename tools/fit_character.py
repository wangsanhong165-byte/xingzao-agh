"""Bounded deterministic silhouette fitting for the editable primitive recipe."""

from __future__ import annotations

import argparse
import copy
import json
import math
import re
import time
from pathlib import Path

import cv2
import numpy as np

from visual_hull import DEFAULT_IMAGE, PANELS, extract_silhouette


CANVAS = 256
CAMERA_SPAN_MM = 120.0
PIXELS_PER_MM = CANVAS / CAMERA_SPAN_MM

# Each parameter changes only named recipe groups and stays inside the builder's
# +/-200 position and <=200 size limits.
PARAMETERS = [
    {"name": "head_width_scale", "kind": "scale", "group": "head", "axis": 0, "bounds": [0.80, 1.25], "steps": [0.15, 0.05]},
    {"name": "head_depth_scale", "kind": "scale", "group": "head", "axis": 1, "bounds": [0.80, 1.25], "steps": [0.15, 0.05]},
    {"name": "head_height_scale", "kind": "scale", "group": "head", "axis": 2, "bounds": [0.80, 1.25], "steps": [0.15, 0.05]},
    {"name": "head_z_shift", "kind": "shift", "group": "head", "axis": 2, "bounds": [-8.0, 8.0], "steps": [4.0, 2.0]},
    {"name": "body_width_scale", "kind": "scale", "group": "body", "axis": 0, "bounds": [0.80, 1.30], "steps": [0.15, 0.05]},
    {"name": "skirt_width_scale", "kind": "scale", "group": "skirt", "axis": 0, "bounds": [0.80, 1.40], "steps": [0.20, 0.05]},
    {"name": "body_z_scale", "kind": "scale", "group": "body", "axis": 2, "bounds": [0.70, 1.30], "steps": [0.15, 0.05]},
    {"name": "body_z_shift", "kind": "shift", "group": "body", "axis": 2, "bounds": [-8.0, 8.0], "steps": [4.0, 2.0]},
    {"name": "tail_y_scale", "kind": "scale", "group": "tail", "axis": 1, "bounds": [0.65, 1.70], "steps": [0.30, 0.10]},
    {"name": "tail_z_shift", "kind": "shift", "group": "tail", "axis": 2, "bounds": [-10.0, 10.0], "steps": [4.0, 2.0]},
]


def part_group(name: str) -> str | None:
    if re.fullmatch(r"head|hair_(back_mass|top)|bangs_(l|mid|r)|side_lock_(l|r)|ear_fin_(l|r)|bow_(l|r)|headband", name):
        return "head"
    if re.fullmatch(r"torso|arm_(l|r)|hand_(l|r)|apron_bib|apron_skirt|skirt|skirt_hem", name):
        return "body"
    if name in {"skirt", "skirt_hem", "apron_skirt"}:
        return "skirt"
    if re.fullmatch(r"fish_tail|tail_fin_[ab]|back_lock_(l|r)", name):
        return "tail"
    return None


def matches_group(name: str, group: str) -> bool:
    if group == "skirt":
        return bool(re.fullmatch(r"skirt|skirt_hem|apron_skirt", name))
    return part_group(name) == group


def adjusted_recipe(recipe: dict, values: dict[str, float]) -> dict:
    output = copy.deepcopy(recipe)
    for part in output["parts"]:
        name = part["name"]
        for definition in PARAMETERS:
            if values[definition["name"]] == (1.0 if definition["kind"] == "scale" else 0.0):
                continue
            group = definition["group"]
            if not matches_group(name, group):
                continue
            axis = definition["axis"]
            value = values[definition["name"]]
            pivot = 70.0 if group == "head" and axis == 2 else 40.0 if group in {"body", "skirt"} and axis == 2 else 0.0
            if definition["kind"] == "scale":
                if part["shape"] == "curve":
                    part["points"] = [
                        [pivot + (coordinate - pivot) * value if coordinate_axis == axis else coordinate for coordinate_axis, coordinate in enumerate(point)]
                        for point in part["points"]
                    ]
                    if group == "tail" and axis == 1:
                        part["radius"] = min(part["radius"] * min(value, 1.25), 200)
                else:
                    part["size"][axis] = min(part["size"][axis] * value, 200.0)
                    if group in {"head", "body", "skirt", "tail"}:
                        part["position"][axis] = pivot + (part["position"][axis] - pivot) * value
            else:
                if part["shape"] == "curve":
                    for point in part["points"]:
                        point[axis] += value
                else:
                    part["position"][axis] += value
            if group == "head" and axis == 2 and definition["kind"] == "scale":
                pass
    return output


def rotation_matrix(degrees: list[float]) -> np.ndarray:
    x, y, z = np.radians(degrees)
    rx = np.array([[1, 0, 0], [0, math.cos(x), -math.sin(x)], [0, math.sin(x), math.cos(x)]])
    ry = np.array([[math.cos(y), 0, math.sin(y)], [0, 1, 0], [-math.sin(y), 0, math.cos(y)]])
    rz = np.array([[math.cos(z), -math.sin(z), 0], [math.sin(z), math.cos(z), 0], [0, 0, 1]])
    return rz @ ry @ rx


def curve_samples(points: list[list[float]], steps_per_segment: int = 8) -> np.ndarray:
    points = np.asarray(points, dtype=np.float64)
    samples = []
    for i in range(len(points) - 1):
        p0 = points[max(i - 1, 0)]
        p1 = points[i]
        p2 = points[i + 1]
        p3 = points[min(i + 2, len(points) - 1)]
        for t in np.linspace(0.0, 1.0, steps_per_segment, endpoint=False):
            t2, t3 = t * t, t * t * t
            samples.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    samples.append(points[-1])
    return np.asarray(samples)


def primitive_points(part: dict) -> np.ndarray:
    shape = part["shape"]
    pos = np.asarray(part.get("position", [0, 0, 0]), dtype=np.float64)
    size = np.asarray(part.get("size", [1, 1, 1]), dtype=np.float64)
    if shape == "curve":
        return curve_samples(part["points"])
    if shape == "ellipsoid":
        theta = np.linspace(0, math.pi, 13)
        phi = np.linspace(0, 2 * math.pi, 32, endpoint=False)
        local = np.array([
            [size[0] * 0.5 * math.sin(t) * math.cos(p), size[1] * 0.5 * math.sin(t) * math.sin(p), size[2] * 0.5 * math.cos(t)]
            for t in theta for p in phi
        ])
    elif shape == "box":
        local = np.array([[sx * size[0] / 2, sy * size[1] / 2, sz * size[2] / 2] for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)])
    elif shape == "cone":
        points = []
        for z, radius in ((-size[2] / 2, size[0] / 2), (size[2] / 2, size[1] / 2)):
            points.extend([[radius * math.cos(a), radius * math.sin(a), z] for a in np.linspace(0, 2 * math.pi, 32, endpoint=False)])
        local = np.asarray(points)
    elif shape == "torus":
        points = []
        for major in np.linspace(0, 2 * math.pi, 32, endpoint=False):
            for minor in np.linspace(0, 2 * math.pi, 12, endpoint=False):
                r = size[0] + size[1] * math.cos(minor)
                points.append([r * math.cos(major), r * math.sin(major), size[1] * math.sin(minor)])
        local = np.asarray(points)
    else:
        raise ValueError(f"Unsupported proxy shape: {shape}")
    return local @ rotation_matrix(part.get("rotation", [0, 0, 0])).T + pos


def all_points(recipe: dict) -> tuple[list[tuple[dict, np.ndarray]], tuple[float, float, float]]:
    result = []
    for part in recipe["parts"]:
        points = primitive_points(part)
        if part["shape"] == "curve":
            radius = float(part["radius"])
            pad = np.full((len(points), 3), radius)
            extent_points = np.concatenate((points - pad, points + pad), axis=0)
        else:
            extent_points = points
        result.append((part, points))
        if len(result) == 1:
            mins = extent_points.min(axis=0)
            maxs = extent_points.max(axis=0)
        else:
            mins = np.minimum(mins, extent_points.min(axis=0))
            maxs = np.maximum(maxs, extent_points.max(axis=0))
    center = ((mins[0] + maxs[0]) / 2, (mins[1] + maxs[1]) / 2, mins[2])
    span_z = maxs[2] - mins[2]
    if span_z <= 1e-6:
        raise ValueError("Recipe proxy has no vertical extent")
    scale = 100.0 / span_z
    normalized = []
    for part, points in result:
        points = points.copy()
        points[:, 0] = (points[:, 0] - center[0]) * scale
        points[:, 1] = (points[:, 1] - center[1]) * scale
        points[:, 2] = (points[:, 2] - center[2]) * scale
        normalized.append((part, points, scale))
    return normalized, (scale, center[0], center[1])


def target_masks(image_path: Path) -> tuple[dict[str, np.ndarray], dict[str, float]]:
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise FileNotFoundError(f"Cannot read source image: {image_path}")
    targets = {}
    widths = {}
    for name, rect in PANELS.items():
        view = extract_silhouette(image, rect)
        mask = view["mask"]
        width_mm = mask.shape[1] * 100.0 / mask.shape[0]
        h_px = int(round(100.0 * PIXELS_PER_MM))
        w_px = max(1, int(round(width_mm * PIXELS_PER_MM)))
        resized = cv2.resize(mask, (w_px, h_px), interpolation=cv2.INTER_NEAREST)
        canvas = np.zeros((CANVAS, CANVAS), dtype=np.uint8)
        left = (CANVAS - w_px) // 2
        top = int(round(10.0 * PIXELS_PER_MM))
        canvas[top : top + h_px, left : left + w_px] = resized
        if name == "back":
            canvas = cv2.flip(canvas, 1)
        targets[name] = canvas
        widths[name] = width_mm
    return targets, widths


def project_point(point: np.ndarray, view: str) -> tuple[float, float]:
    x, y, z = point
    horizontal = -x if view == "back" else y if view == "side" else x
    px = (horizontal / CAMERA_SPAN_MM + 0.5) * CANVAS
    py = (110.0 - z) / CAMERA_SPAN_MM * CANVAS
    return px, py


def render_proxy(recipe: dict) -> dict[str, np.ndarray]:
    normalized, _ = all_points(recipe)
    images = {name: np.zeros((CANVAS, CANVAS), dtype=np.uint8) for name in ("front", "side", "back")}
    for part, points, scale in normalized:
        if part["shape"] == "curve":
            radius = max(1, int(round(part["radius"] * scale * PIXELS_PER_MM * 2)))
            for view in images:
                projected = np.asarray([project_point(point, view) for point in points], dtype=np.int32)
                cv2.polylines(images[view], [projected], False, 255, thickness=radius, lineType=cv2.LINE_8)
                for point in (projected[0], projected[-1]):
                    cv2.circle(images[view], tuple(point), radius // 2, 255, cv2.FILLED)
            continue

        for view in images:
            projected = np.asarray([project_point(point, view) for point in points], dtype=np.float32)
            hull = cv2.convexHull(projected.astype(np.int32))
            if len(hull) >= 3:
                cv2.fillConvexPoly(images[view], hull, 255, lineType=cv2.LINE_8)
            elif len(hull) == 2:
                cv2.line(images[view], tuple(hull[0, 0]), tuple(hull[1, 0]), 255, 1)
    return images


def silhouette_metrics(prediction: np.ndarray, target: np.ndarray) -> dict:
    pred = (prediction != 0).astype(np.uint8)
    truth = (target != 0).astype(np.uint8)
    intersection = int(np.count_nonzero(pred & truth))
    union = int(np.count_nonzero(pred | truth))
    iou = intersection / union if union else 1.0
    pred_edge = cv2.Canny(pred * 255, 50, 150) != 0
    target_edge = cv2.Canny(truth * 255, 50, 150) != 0
    d_to_truth = cv2.distanceTransform((~target_edge).astype(np.uint8), cv2.DIST_L2, 3)
    d_to_pred = cv2.distanceTransform((~pred_edge).astype(np.uint8), cv2.DIST_L2, 3)
    if np.any(pred_edge) and np.any(target_edge):
        chamfer_px = float((d_to_truth[pred_edge].mean() + d_to_pred[target_edge].mean()) / 2)
    else:
        chamfer_px = float(CANVAS)
    normalized_chamfer = min(chamfer_px / CANVAS, 1.0)
    return {"iou": round(iou, 5), "symmetricContourDistancePx": round(chamfer_px, 3), "score": round(0.8 * iou + 0.2 * (1 - normalized_chamfer), 5)}


def score_recipe(recipe: dict, targets: dict[str, np.ndarray]) -> tuple[float, dict, dict[str, np.ndarray]]:
    projections = render_proxy(recipe)
    metrics = {name: silhouette_metrics(projections[name], targets[name]) for name in projections}
    return float(np.mean([item["score"] for item in metrics.values()])), metrics, projections


def validate_recipe(recipe: dict) -> None:
    if len(recipe.get("parts", [])) > 100:
        raise ValueError("Recipe exceeds 100 parts")
    for part in recipe["parts"]:
        for axis, value in enumerate(part.get("position", [0, 0, 0])):
            if not math.isfinite(value) or abs(value) > 200:
                raise ValueError(f"part {part['name']} position axis {axis} exceeds +/-200")
        for value in part.get("size", [1, 1, 1]):
            if not math.isfinite(value) or value < 0 or value > 200:
                raise ValueError(f"part {part['name']} size exceeds 200")
        for point in part.get("points", []):
            if any(not math.isfinite(value) or abs(value) > 200 for value in point):
                raise ValueError(f"part {part['name']} point exceeds +/-200")


def fit(recipe: dict, targets: dict[str, np.ndarray]) -> tuple[dict, dict]:
    values = {definition["name"]: (1.0 if definition["kind"] == "scale" else 0.0) for definition in PARAMETERS}
    current = copy.deepcopy(recipe)
    best_score, best_views, _ = score_recipe(current, targets)
    evaluations = 1
    history = []
    for step_index in range(2):
        for definition in PARAMETERS:
            name = definition["name"]
            delta = definition["steps"][step_index]
            low, high = definition["bounds"]
            direction_best = None
            score_best = best_score
            metrics_best = best_views
            for direction in (-1, 1):
                candidate_value = min(max(values[name] + direction * delta, low), high)
                if abs(candidate_value - values[name]) < 1e-9:
                    continue
                candidate_values = dict(values)
                candidate_values[name] = candidate_value
                candidate = adjusted_recipe(recipe, candidate_values)
                validate_recipe(candidate)
                score, metrics, _ = score_recipe(candidate, targets)
                evaluations += 1
                if score > score_best + 1e-8:
                    score_best = score
                    direction_best = candidate_value
                    metrics_best = metrics
            if direction_best is not None:
                values[name] = direction_best
                current = adjusted_recipe(recipe, values)
                best_score, best_views = score_best, metrics_best
                history.append({"parameter": name, "step": delta, "value": direction_best, "score": round(best_score, 5)})
    validate_recipe(current)
    return current, {
        "parameters": values,
        "score": round(best_score, 5),
        "perView": best_views,
        "evaluations": evaluations,
        "acceptedSteps": history,
        "search": "deterministic coordinate search: 2 sweeps x 10 parameters x coarse/fine bounded steps",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Fit a bounded primitive recipe to three silhouette masks.")
    parser.add_argument("--recipe", type=Path, default=Path("data/character-test/recipe.json"))
    parser.add_argument("--image", type=Path, default=DEFAULT_IMAGE)
    parser.add_argument("--hull", type=Path, default=Path("data/character-test/hull.json"))
    parser.add_argument("--masks", type=Path, default=Path("data/character-test/masks.png"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/character-test"))
    args = parser.parse_args()

    started = time.perf_counter()
    recipe = json.loads(args.recipe.read_text(encoding="utf-8"))
    hull = json.loads(args.hull.read_text(encoding="utf-8"))
    if not args.masks.is_file():
        raise FileNotFoundError(f"Extracted mask diagnostic not found: {args.masks}")
    if hull.get("metrics", {}).get("grid", {}).get("nz") != 192:
        raise ValueError("Expected the 128x96x192 visual hull metrics")
    targets, target_widths = target_masks(args.image)
    baseline_score, baseline_views, _ = score_recipe(recipe, targets)
    fitted, fit_report = fit(recipe, targets)
    fitted_score, fitted_views, _ = score_recipe(fitted, targets)

    fitted["assumptions"] = list(fitted.get("assumptions", [])) + [
        "部件参数经过三视图二值轮廓代理拟合；该代理使用确定性采样，不代表Blender实渲染已改善。"
    ]
    fitted["limitations"] = list(fitted.get("limitations", [])) + [
        "参数拟合目标为正/侧/背二值轮廓的近似投影，不会自动保证部件连接、遮挡关系、外观保真或可打印性。"
    ]
    validate_recipe(fitted)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    recipe_path = args.output_dir / "fitted-recipe.json"
    report_path = args.output_dir / "fit-report.json"
    recipe_path.write_text(json.dumps(fitted, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    report = {
        "recipeInput": str(args.recipe),
        "hullInput": str(args.hull),
        "maskDiagnosticInput": str(args.masks),
        "sourceImage": str(args.image),
        "targetNormalization": {"heightMm": 100, "cameraSpanMm": CAMERA_SPAN_MM, "targetWidthMm": {key: round(value, 3) for key, value in target_widths.items()}},
        "parameters": fit_report["parameters"],
        "bounds": {definition["name"]: definition["bounds"] for definition in PARAMETERS},
        "baseline": {"score": round(baseline_score, 5), "perView": baseline_views},
        "fitted": {"score": round(fitted_score, 5), "perView": fitted_views},
        "improvement": round(fitted_score - baseline_score, 5),
        "evaluations": fit_report["evaluations"],
        "acceptedSteps": fit_report["acceptedSteps"],
        "search": fit_report["search"],
        "proxyLimitations": [
            "Ellipsoid, box, cone and torus projections use sampled convex hulls; curves use sampled centerlines with circular 2D thickness.",
            "The target masks use the same largest-component, external-contour fill as visual_hull.py; white interior details are not scored.",
            "Scores compare fixed orthographic binary silhouettes only, not colors, part intersections, normals, or Blender-rendered appearance.",
            "The three source drawings are not perfectly orthographic or scale-matched; height normalization is a fitting convenience, not real measurement.",
        ],
        "elapsedSeconds": round(time.perf_counter() - started, 3),
        "outputs": {"recipe": str(recipe_path), "report": str(report_path)},
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
