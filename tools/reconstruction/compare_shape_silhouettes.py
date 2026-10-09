#!/usr/bin/env python3
"""Compare uncalibrated reference and fixed-blue render silhouettes.

This is a shape-silhouette proxy only. It is not a 3D ground-truth metric and
does not measure face, hair, texture, scale, or physical-print fidelity.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage


VIEWS = ("front", "left", "back")
TARGET_GROUP_HEIGHT = 320
MIN_CANVAS_WIDTH = 1024
MIN_CANVAS_HEIGHT = 512
CANVAS_PADDING = 32
BLUE_MIN_VALUE = 55
BLUE_RED_DELTA = 28
BLUE_GREEN_DELTA = 12
CANDIDATE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
LABEL = "shape silhouette proxy only"


class ProbeError(ValueError):
    """An input or evaluation condition that prevents a valid comparison."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _read_png(path: Path, *, require_rgba: bool) -> Image.Image:
    if not path.is_file():
        raise ProbeError(f"missing PNG input: {path.name}")
    try:
        image = Image.open(path)
        image.load()
    except Exception as exc:  # Pillow emits several format-specific errors.
        raise ProbeError(f"cannot read PNG input {path.name}: {exc}") from exc
    if image.format != "PNG":
        raise ProbeError(f"input must be PNG: {path.name}")
    if require_rgba and image.mode != "RGBA":
        raise ProbeError(f"reference PNG must be RGBA with an alpha silhouette: {path.name}")
    return image


def _mask_bbox(mask: np.ndarray, label: str) -> tuple[int, int, int, int]:
    rows, columns = np.nonzero(mask)
    if rows.size == 0:
        raise ProbeError(f"empty silhouette in {label}")
    return int(columns.min()), int(rows.min()), int(columns.max()) + 1, int(rows.max()) + 1


def load_reference_group(directory: Path) -> tuple[dict[str, np.ndarray], dict[str, str], dict[str, tuple[int, int, int, int]]]:
    masks: dict[str, np.ndarray] = {}
    hashes: dict[str, str] = {}
    boxes: dict[str, tuple[int, int, int, int]] = {}
    for view in VIEWS:
        path = directory / f"{view}.png"
        image = _read_png(path, require_rgba=True)
        mask = np.asarray(image.getchannel("A")) > 0
        if mask.ndim != 2 or min(mask.shape) < 1:
            raise ProbeError(f"invalid alpha silhouette in {path.name}")
        masks[view] = mask
        boxes[view] = _mask_bbox(mask, path.name)
        hashes[path.name] = sha256_file(path)
    return masks, hashes, boxes


def load_candidate_group(directory: Path, method: str = 'blue-chroma') -> tuple[dict[str, np.ndarray], dict[str, str], dict[str, tuple[int, int, int, int]]]:
    masks: dict[str, np.ndarray] = {}
    hashes: dict[str, str] = {}
    boxes: dict[str, tuple[int, int, int, int]] = {}
    for view in VIEWS:
        path = directory / f"{view}.png"
        image = _read_png(path, require_rgba=method == 'render-alpha')
        if method == 'render-alpha':
            alpha = np.asarray(image.getchannel('A'))
            if not np.any(alpha == 0):
                raise ProbeError(f'render alpha requires a transparent background in {path.name}')
            mask = alpha >= 128
        elif method == 'blue-chroma':
            rgb = np.asarray(image.convert('RGB'), dtype=np.int16)
            red, green, blue = rgb[..., 0], rgb[..., 1], rgb[..., 2]
            mask = ((blue >= BLUE_MIN_VALUE) & ((blue - red) >= BLUE_RED_DELTA) & ((blue - green) >= BLUE_GREEN_DELTA))
        else:
            raise ProbeError('candidate silhouette method is unsupported')
        masks[view] = mask
        boxes[view] = _mask_bbox(mask, f"{'blue' if method == 'blue-chroma' else 'render-alpha'} silhouette in {path.name}")
        hashes[path.name] = sha256_file(path)
    return masks, hashes, boxes


def _group_scale(boxes: dict[str, tuple[int, int, int, int]]) -> tuple[float, int]:
    max_height = max(bottom - top for _, top, _, bottom in boxes.values())
    if max_height <= 0:
        raise ProbeError("empty silhouette group")
    return TARGET_GROUP_HEIGHT / max_height, max_height


def scale_group(
    masks: dict[str, np.ndarray], boxes: dict[str, tuple[int, int, int, int]], scale: float
) -> dict[str, np.ndarray]:
    scaled: dict[str, np.ndarray] = {}
    for view in VIEWS:
        mask = masks[view]
        left, top, right, bottom = boxes[view]
        crop = mask[top:bottom, left:right]
        width = max(1, int(round(crop.shape[1] * scale)))
        height = max(1, int(round(crop.shape[0] * scale)))
        image = Image.fromarray(crop.astype(np.uint8) * 255, mode="L")
        resized = image.resize((width, height), resample=Image.Resampling.NEAREST)
        scaled[view] = np.asarray(resized) > 0
    return scaled


def canvas_size(groups: list[dict[str, np.ndarray]]) -> tuple[int, int]:
    widest = max(mask.shape[1] for group in groups for mask in group.values())
    width = max(MIN_CANVAS_WIDTH, widest + 2 * CANVAS_PADDING)
    height = max(MIN_CANVAS_HEIGHT, TARGET_GROUP_HEIGHT + 2 * CANVAS_PADDING)
    return width, height


def align_to_canvas(mask: np.ndarray, width: int, height: int) -> np.ndarray:
    object_height, object_width = mask.shape
    if object_width + 2 * CANVAS_PADDING > width:
        raise ProbeError("canvas width would crop a silhouette")
    if object_height + 2 * CANVAS_PADDING > height:
        raise ProbeError("canvas height would crop a silhouette")
    left = (width - object_width) // 2
    top = height - CANVAS_PADDING - object_height
    canvas = np.zeros((height, width), dtype=bool)
    canvas[top : top + object_height, left : left + object_width] = mask
    return canvas


def _boundary(mask: np.ndarray) -> np.ndarray:
    eroded = ndimage.binary_erosion(mask, structure=np.ones((3, 3), dtype=bool), border_value=0)
    return mask & ~eroded


def compare_masks(reference: np.ndarray, candidate: np.ndarray) -> tuple[dict[str, float], np.ndarray]:
    if reference.shape != candidate.shape:
        raise ProbeError("aligned silhouettes must use the same canvas")
    ref_boundary = _boundary(reference)
    candidate_boundary = _boundary(candidate)
    ref_to_candidate = ndimage.distance_transform_edt(~candidate_boundary)[ref_boundary]
    candidate_to_ref = ndimage.distance_transform_edt(~ref_boundary)[candidate_boundary]
    distances = np.concatenate((ref_to_candidate, candidate_to_ref)).astype(np.float64)
    if distances.size == 0:
        raise ProbeError("empty silhouette boundary")
    intersection = int(np.count_nonzero(reference & candidate))
    union = int(np.count_nonzero(reference | candidate))
    if union == 0:
        raise ProbeError("empty silhouette union")
    return (
        {
            "iou": intersection / union,
            "boundary_distance_mean_px": float(np.mean(distances)),
            "boundary_distance_p95_px": float(np.percentile(distances, 95)),
            "boundary_distance_max_px": float(np.max(distances)),
        },
        distances,
    )


def make_overlay(reference: np.ndarray, candidate: np.ndarray, view: str, candidate_name: str, metrics: dict[str, float]) -> Image.Image:
    height, width = reference.shape
    overlay = np.full((height, width, 3), 250, dtype=np.uint8)
    ref_only = reference & ~candidate
    candidate_only = candidate & ~reference
    overlap = reference & candidate
    overlay[ref_only] = (227, 76, 67)       # Reference-only silhouette.
    overlay[candidate_only] = (42, 105, 190) # Candidate-only silhouette.
    overlay[overlap] = (46, 142, 105)        # Shared silhouette.
    image = Image.fromarray(overlay, mode="RGB")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default()
    draw.rectangle((0, 0, width - 1, 22), fill=(255, 255, 255))
    draw.text((8, 6), f"{candidate_name} / {view}  |  shape silhouette proxy only", fill=(25, 35, 40), font=font)
    legend_y = height - 23
    draw.rectangle((0, legend_y, width - 1, height - 1), fill=(255, 255, 255))
    draw.rectangle((8, legend_y + 7, 18, legend_y + 17), fill=(227, 76, 67))
    draw.text((22, legend_y + 7), "reference", fill=(25, 35, 40), font=font)
    draw.rectangle((93, legend_y + 7, 103, legend_y + 17), fill=(42, 105, 190))
    draw.text((107, legend_y + 7), "candidate", fill=(25, 35, 40), font=font)
    draw.rectangle((188, legend_y + 7, 198, legend_y + 17), fill=(46, 142, 105))
    draw.text((202, legend_y + 7), "overlap", fill=(25, 35, 40), font=font)
    draw.text((280, legend_y + 7), f"IoU {metrics['iou']:.4f}  boundary mean {metrics['boundary_distance_mean_px']:.2f}px", fill=(25, 35, 40), font=font)
    return image


def parse_candidate(value: str) -> tuple[str, Path]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("candidate must be NAME=RENDER_DIR")
    name, directory = value.split("=", 1)
    if not CANDIDATE_NAME.fullmatch(name):
        raise argparse.ArgumentTypeError("candidate NAME may contain only letters, digits, dot, underscore, and hyphen")
    if not directory:
        raise argparse.ArgumentTypeError("candidate RENDER_DIR must not be empty")
    return name, Path(directory)


def evaluate(reference_directory: Path, candidates: list[tuple[str, Path]], output_directory: Path, candidate_mask: str = 'blue-chroma') -> dict:
    if output_directory.exists():
        raise ProbeError(f"output directory already exists; refusing to overwrite: {output_directory}")
    if not reference_directory.is_dir():
        raise ProbeError("reference-dir must be an existing directory")
    if not candidates:
        raise ProbeError("at least one --candidate NAME=RENDER_DIR is required")
    names = [name for name, _ in candidates]
    if len(set(names)) != len(names):
        raise ProbeError("candidate names must be unique")

    ref_masks, ref_hashes, ref_boxes = load_reference_group(reference_directory)
    ref_scale, ref_max_height = _group_scale(ref_boxes)
    scaled_reference = scale_group(ref_masks, ref_boxes, ref_scale)

    candidate_groups = []
    for name, directory in candidates:
        if not directory.is_dir():
            raise ProbeError(f"candidate render-dir must be an existing directory: {name}")
        masks, hashes, boxes = load_candidate_group(directory, candidate_mask)
        scale, max_height = _group_scale(boxes)
        candidate_groups.append(
            {
                "name": name,
                "masks": masks,
                "hashes": hashes,
                "boxes": boxes,
                "scale": scale,
                "max_height": max_height,
                "scaled": scale_group(masks, boxes, scale),
            }
        )
    width, height = canvas_size([scaled_reference] + [item["scaled"] for item in candidate_groups])
    reference_aligned = {view: align_to_canvas(scaled_reference[view], width, height) for view in VIEWS}

    prepared_results = []
    for candidate in candidate_groups:
        candidate_aligned = {view: align_to_canvas(candidate["scaled"][view], width, height) for view in VIEWS}
        view_results = {}
        distance_chunks = []
        for view in VIEWS:
            metrics, distances = compare_masks(reference_aligned[view], candidate_aligned[view])
            view_results[view] = metrics
            distance_chunks.append(distances)
        all_distances = np.concatenate(distance_chunks)
        mean_iou = float(np.mean([view_results[view]["iou"] for view in VIEWS]))
        aggregate = {
            "mean_iou": mean_iou,
            "boundary_distance_mean_px": float(np.mean(all_distances)),
            "boundary_distance_p95_px": float(np.percentile(all_distances, 95)),
            "boundary_distance_max_px": float(np.max(all_distances)),
        }
        prepared_results.append((candidate, view_results, candidate_aligned, aggregate, all_distances))

    prepared_results.sort(key=lambda result: (-result[3]["mean_iou"], result[3]["boundary_distance_mean_px"]))
    output_directory.mkdir(parents=True, exist_ok=False)
    candidate_reports = []
    for rank, (candidate, view_results, candidate_aligned, aggregate, _) in enumerate(prepared_results, start=1):
        overlays = {}
        for view in VIEWS:
            filename = f"{candidate['name']}-{view}-overlay.png"
            overlay = make_overlay(reference_aligned[view], candidate_aligned[view], view, candidate["name"], view_results[view])
            overlay.save(output_directory / filename, format="PNG", optimize=False)
            overlays[view] = filename
        candidate_reports.append(
            {
                "name": candidate["name"],
                "proxy_rank": rank,
                "aggregate": aggregate,
                "views": view_results,
                "source_sha256": candidate["hashes"],
                "overlays": overlays,
                "normalization": {
                    "shared_group_scale_px_per_source_px": candidate["scale"],
                    "source_group_max_bbox_height_px": candidate["max_height"],
                    "target_group_max_bbox_height_px": TARGET_GROUP_HEIGHT,
                    "aspect_ratio_preserved": True,
                },
            }
        )

    report = {
        "label": LABEL,
        "candidate_silhouette_method": candidate_mask,
        "render_alpha_threshold": 128 if candidate_mask == 'render-alpha' else None,
        "ranking_proxy_only": True,
        "review_required": True,
        "not_three_dimensional_ground_truth": True,
        "not_face_or_hair_detail": True,
        "not_absolute_scale_or_texture": True,
        "not_production_default": True,
        "ranking_method": "mean IoU descending; boundary-distance mean ascending as tie-break; proxy only",
        "scope": "uncalibrated three-view silhouette comparison; no view optimization or independent horizontal resizing",
        "alignment": {
            "horizontal": "centered per view",
            "vertical": "bottom aligned per view",
            "camera_calibration_assumed": False,
        },
        "normalization": {
            "mode": "one uniform scale shared by the three images within each image group",
            "reference_group_max_bbox_height_px": ref_max_height,
            "reference_group_scale_px_per_source_px": ref_scale,
            "target_group_max_bbox_height_px": TARGET_GROUP_HEIGHT,
            "aspect_ratio_preserved": True,
        },
        "canvas": {"width": width, "height": height, "minimum_width": MIN_CANVAS_WIDTH, "minimum_height": MIN_CANVAS_HEIGHT, "cropped": False},
        "reference_source_sha256": ref_hashes,
        "metrics_definition": {
            "iou": "intersection over union of aligned binary silhouettes",
            "boundary_distance_mean_px": "mean of both directed nearest-boundary distances",
            "boundary_distance_p95_px": "95th percentile of concatenated both-direction boundary distances",
            "boundary_distance_max_px": "maximum of concatenated both-direction boundary distances",
            "aggregate": "mean IoU across views; boundary metrics from concatenated boundary samples across views",
        },
        "blue_chroma_extractor": {
            "applied": candidate_mask == 'blue-chroma',
            "rule": f"B >= {BLUE_MIN_VALUE}, B-R >= {BLUE_RED_DELTA}, B-G >= {BLUE_GREEN_DELTA}",
            "background_assumption": "neutral gray or white",
        },
        "candidates": candidate_reports,
    }
    (output_directory / "shape-silhouette-proxy.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8"
    )
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=LABEL)
    parser.add_argument("--reference-dir", required=True, type=Path, help="directory containing front.png, left.png, back.png as RGBA reference views")
    parser.add_argument("--candidate", action="append", required=True, type=parse_candidate, metavar="NAME=RENDER_DIR", help="fixed-blue Blender Workbench PNG render directory; repeat for each candidate")
    parser.add_argument("--output-dir", required=True, type=Path, help="new output directory; existing paths are refused")
    parser.add_argument('--candidate-mask', choices=('blue-chroma','render-alpha'), default='blue-chroma', help='explicit render-alpha requires a true transparent-background render; dark material remains occupied geometry')
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        report = evaluate(args.reference_dir, args.candidate, args.output_dir, args.candidate_mask)
    except (ProbeError, OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({"output_dir": str(args.output_dir), "candidates": len(report["candidates"]), "ranking_proxy_only": True}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
