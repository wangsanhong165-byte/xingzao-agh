"""Conservative CPU projection of multi-view image colors onto an unchanged mesh.

The result is glTF ``COLOR_0`` vertex color data.  This is not UV texturing,
camera calibration, material recovery, or an attempt to invent unseen surfaces.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

import numpy as np
import PIL
import scipy
import trimesh
from scipy import ndimage
from PIL import Image


NEUTRAL = np.array([128, 128, 128, 255], dtype=np.uint8)
MAX_SOURCE_BYTES = 25 * 1024 * 1024
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_IMAGE_PIXELS = 12_000_000
MAX_FACES = 250_000
RAY_BATCH_SIZE = 2048
MIN_FACING_DOT = 0.5  # no more than 60 degrees off the surface normal


def _as_image(image: Any) -> np.ndarray:
    if isinstance(image, Image.Image):
        rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8)
    else:
        rgba = np.asarray(image)
        if rgba.ndim != 3 or rgba.shape[2] not in (3, 4):
            raise ValueError("each view must be an RGB/RGBA image array or PIL image")
        if rgba.dtype != np.uint8:
            if not np.issubdtype(rgba.dtype, np.number) or not np.isfinite(rgba).all():
                raise ValueError("view pixels must be finite uint8-like values")
            rgba = np.clip(rgba, 0, 255).astype(np.uint8)
        if rgba.shape[2] == 3:
            alpha = np.full((*rgba.shape[:2], 1), 255, dtype=np.uint8)
            rgba = np.concatenate((rgba, alpha), axis=2)
        else:
            rgba = rgba.copy()
    if rgba.shape[0] < 1 or rgba.shape[1] < 1:
        raise ValueError("view image cannot be empty")
    return rgba


def _foreground_mask(rgba: np.ndarray) -> np.ndarray:
    """Use alpha and exclude only edge-connected near-white RGB background."""
    rgb = rgba[..., :3].astype(np.int16)
    opaque = rgba[..., 3] > 0
    near_white = (rgb.min(axis=2) >= 245) & ((rgb.max(axis=2) - rgb.min(axis=2)) <= 12)
    height, width = near_white.shape
    seeds = np.zeros(near_white.shape, dtype=bool)
    seeds[0, :] = near_white[0, :]
    seeds[-1, :] |= near_white[-1, :]
    seeds[:, 0] |= near_white[:, 0]
    seeds[:, -1] |= near_white[:, -1]
    # Four-connectivity deliberately preserves enclosed white details.
    background = ndimage.binary_propagation(
        seeds,
        structure=np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=bool),
        mask=near_white,
    )
    return opaque & ~background


def _camera_axes(name: str, camera: Mapping[str, Any]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    # ``position`` (or ``direction``) points from object toward camera.
    raw = camera.get("position", camera.get("direction"))
    if raw is None:
        raise ValueError(f"camera {name!r} requires position/direction and up vectors")
    camera_position = np.asarray(raw, dtype=np.float64)
    up = np.asarray(camera.get("up", (0, 0, 1)), dtype=np.float64)
    if camera_position.shape != (3,) or up.shape != (3,) or not np.isfinite(camera_position).all() or not np.isfinite(up).all():
        raise ValueError(f"camera {name!r} vectors must be finite 3D camera vectors")
    norm = float(np.linalg.norm(camera_position))
    if norm <= 1e-12:
        raise ValueError(f"camera {name!r} direction cannot be zero")
    camera_position /= norm
    view_direction = -camera_position
    right = np.cross(view_direction, up)
    right_norm = float(np.linalg.norm(right))
    if right_norm <= 1e-12:
        raise ValueError(f"camera {name!r} up vector cannot be parallel to its direction")
    right /= right_norm
    screen_up = np.cross(right, view_direction)
    screen_up /= np.linalg.norm(screen_up)
    return camera_position, right, screen_up


def _vertex_normals(mesh: trimesh.Trimesh) -> np.ndarray:
    triangles = np.asarray(mesh.triangles, dtype=np.float64)
    face_vectors = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    normals = np.zeros((len(mesh.vertices), 3), dtype=np.float64)
    for corner in range(3):
        np.add.at(normals, mesh.faces[:, corner], face_vectors)
    lengths = np.linalg.norm(normals, axis=1)
    valid = lengths > 1e-15
    normals[valid] /= lengths[valid, None]
    return normals


def _visible_vertices(mesh: trimesh.Trimesh, vertices: np.ndarray, camera_position: np.ndarray) -> np.ndarray:
    """First-hit visibility by CPU orthographic rays against the original mesh."""
    # STL inputs are triangle soups, so many source rows can share an exact
    # position. Cast one ray per unique position and fan visibility back out;
    # this keeps the CPU budget proportional to geometric vertices while
    # preserving the original vertex/face indexing used by COLOR_0.
    unique_vertices, inverse = np.unique(vertices, axis=0, return_inverse=True)
    bounds = np.asarray(mesh.bounds, dtype=np.float64)
    diagonal = float(np.linalg.norm(bounds[1] - bounds[0]))
    ray_length = max(diagonal * 2.0 + 1.0, 1.0)
    tolerance = max(diagonal * 2e-6, 1e-7)
    unique_visible = np.zeros(len(unique_vertices), dtype=bool)
    directions = np.broadcast_to(-camera_position, (min(RAY_BATCH_SIZE, len(unique_vertices)), 3))
    try:
        ray = mesh.ray
        for start in range(0, len(unique_vertices), RAY_BATCH_SIZE):
            end = min(start + RAY_BATCH_SIZE, len(unique_vertices))
            origins = unique_vertices[start:end] + camera_position * ray_length
            batch_directions = directions[: end - start]
            locations, ray_indices, _ = ray.intersects_location(
                origins, batch_directions, multiple_hits=False
            )
            if len(ray_indices):
                distances = np.linalg.norm(locations - unique_vertices[start + ray_indices], axis=1)
                for local_ray in np.unique(ray_indices[distances <= tolerance]):
                    unique_visible[start + local_ray] = True
    except Exception as exc:
        raise RuntimeError(
            "CPU first-hit visibility failed; install no new dependencies automatically "
            "and ensure trimesh's existing rtree ray backend works"
        ) from exc
    return unique_visible[inverse]


def project_colors(
    mesh: trimesh.Trimesh,
    views: Mapping[str, Any],
    cameras: Mapping[str, Mapping[str, Any]],
    min_coverage: float | None = None,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Project view pixels onto source vertices with conservative visibility.

    Returns ``(rgba_srgb_u8, report)``. ``cameras[name].position`` is the
    direction from the object toward that camera; ``up`` fixes the image roll.
    The projection independently maps model/image foreground bounding boxes,
    so it is an uncalibrated orthographic alignment heuristic. Views are
    winner-take-best by normal facing; no view blending or hidden-surface fill
    is performed. Unassigned vertices retain opaque neutral sRGB gray.
    """
    if not isinstance(mesh, trimesh.Trimesh) or len(mesh.vertices) == 0 or len(mesh.faces) == 0:
        raise ValueError("mesh must be a non-empty trimesh.Trimesh")
    if not views:
        raise ValueError("at least one view is required")
    if min_coverage is not None and not 0.0 <= float(min_coverage) <= 1.0:
        raise ValueError("min_coverage must be between 0 and 1")
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces)
    if not np.isfinite(vertices).all() or faces.ndim != 2 or faces.shape[1] != 3:
        raise ValueError("mesh must have finite vertices and triangular faces")

    colors = np.tile(NEUTRAL, (len(vertices), 1))
    assigned = np.zeros(len(vertices), dtype=bool)
    best_facing = np.full(len(vertices), -np.inf, dtype=np.float64)
    reasons: Counter[str] = Counter()
    per_view: dict[str, dict[str, int]] = {}
    normals = _vertex_normals(mesh)
    bounds = np.asarray(mesh.bounds, dtype=np.float64)
    diagonal = float(np.linalg.norm(bounds[1] - bounds[0]))
    position_tolerance = max(diagonal * 1e-10, 1e-12)

    for name, image in views.items():
        if name not in cameras:
            raise ValueError(f"missing camera configuration for view {name!r}")
        rgba = _as_image(image)
        mask = _foreground_mask(rgba)
        camera_position, right, screen_up = _camera_axes(name, cameras[name])
        facing = normals @ camera_position
        candidate = facing >= MIN_FACING_DOT
        view_stats = {"facing_candidates": int(candidate.sum()), "visible": 0, "occluded_or_missed_first_hit": 0, "sampled": 0, "selected": 0}
        if not candidate.any():
            reasons["no_front_facing_normal"] += len(vertices)
            per_view[name] = view_stats
            continue

        visible = _visible_vertices(mesh, vertices, camera_position)
        view_stats["visible"] = int((visible & candidate).sum())
        hidden_count = int((~visible & candidate).sum())
        view_stats["occluded_or_missed_first_hit"] = hidden_count
        reasons["occluded_or_missed_first_hit"] += hidden_count
        candidate &= visible
        if not candidate.any():
            per_view[name] = view_stats
            continue
        foreground_y, foreground_x = np.nonzero(mask)
        if len(foreground_x) == 0:
            reasons["empty_foreground_mask"] += int(candidate.sum())
            per_view[name] = view_stats
            continue

        projected_x = vertices @ right
        projected_y = vertices @ screen_up
        model_x_min, model_x_max = float(projected_x.min()), float(projected_x.max())
        model_y_min, model_y_max = float(projected_y.min()), float(projected_y.max())
        if model_x_max - model_x_min <= position_tolerance or model_y_max - model_y_min <= position_tolerance:
            reasons["degenerate_projection_bounds"] += int(candidate.sum())
            per_view[name] = view_stats
            continue

        ys = np.flatnonzero(candidate)
        u = (projected_x[ys] - model_x_min) / (model_x_max - model_x_min)
        v = (projected_y[ys] - model_y_min) / (model_y_max - model_y_min)
        image_x = np.rint(foreground_x.min() + u * (foreground_x.max() - foreground_x.min())).astype(np.int64)
        image_y = np.rint(foreground_y.max() - v * (foreground_y.max() - foreground_y.min())).astype(np.int64)
        image_x = np.clip(image_x, 0, rgba.shape[1] - 1)
        image_y = np.clip(image_y, 0, rgba.shape[0] - 1)
        sampled_valid = mask[image_y, image_x]
        reasons["transparent_or_background_sample"] += int((~sampled_valid).sum())
        view_stats["sampled"] = int(sampled_valid.sum())
        if not sampled_valid.any():
            per_view[name] = view_stats
            continue
        ys = ys[sampled_valid]
        image_y = image_y[sampled_valid]
        image_x = image_x[sampled_valid]
        sampled_facing = facing[ys]
        choose = sampled_facing > best_facing[ys]
        ys, image_y, image_x = ys[choose], image_y[choose], image_x[choose]
        colors[ys] = rgba[image_y, image_x]
        best_facing[ys] = facing[ys]
        assigned[ys] = True
        view_stats["selected"] = int(len(ys))
        per_view[name] = view_stats

    coverage = float(assigned.mean()) if len(assigned) else 0.0
    report = {
        "colored_vertices": int(assigned.sum()),
        "unknown_vertices": int((~assigned).sum()),
        "vertex_coverage": coverage,
        "unknown_reasons_observed": dict(reasons),
        "unknown_reason_note": "counts are per-view observations and may overlap; unknown_vertices is the unique final vertex count",
        "per_view": per_view,
        "neutral_srgb": [int(value) for value in NEUTRAL],
        "selection": "highest-facing-visible-valid-view",
        "minimum_normal_facing_dot": MIN_FACING_DOT,
        "visibility": "CPU first-hit orthographic rays against unchanged input mesh",
        "projection": "uncalibrated orthographic image/model foreground bbox alignment",
        "projection_scope": "vertex COLOR_0 only; not UV texture, calibrated reprojection, or recovered material/albedo",
        "blend": "none; winner-take-best view",
        "unknown_policy": "opaque neutral gray; no completion or hidden-surface painting",
    }
    if min_coverage is not None and coverage < float(min_coverage):
        raise ValueError(
            f"vertex coverage {coverage:.6f} is below required min_coverage {float(min_coverage):.6f}"
        )
    return colors, report


def _canonical_triangle_fingerprint(mesh: trimesh.Trimesh) -> str:
    """Hash oriented triangle coordinates, independent of vertex indices/order."""
    triangles = np.asarray(mesh.triangles, dtype=np.float32)
    # Cyclic rotations preserve each triangle's winding. Reversals are never
    # considered, so a winding flip changes the proof.
    flattened = triangles.reshape((-1, 3, 3))
    rotations = (flattened, np.roll(flattened, -1, axis=1), np.roll(flattened, -2, axis=1))
    keys = [rotation.reshape((-1, 9)) for rotation in rotations]

    def lexicographically_less(a: np.ndarray, b: np.ndarray) -> np.ndarray:
        undecided = np.ones(len(a), dtype=bool)
        less = np.zeros(len(a), dtype=bool)
        for column in range(9):
            less |= undecided & (a[:, column] < b[:, column])
            undecided &= a[:, column] == b[:, column]
        return less

    # Pick the smallest cyclic form per triangle without reversing winding.
    chosen = keys[0].copy()
    smaller = lexicographically_less(keys[1], chosen)
    chosen[smaller] = keys[1][smaller]
    smaller = lexicographically_less(keys[2], chosen)
    chosen[smaller] = keys[2][smaller]
    if len(chosen):
        order = np.lexsort(tuple(chosen[:, i] for i in range(8, -1, -1)))
        chosen = chosen[order]
    digest = hashlib.sha256()
    digest.update(np.asarray([len(chosen)], dtype="<u8").tobytes())
    digest.update(np.asarray(chosen, dtype="<f4").tobytes(order="C"))
    return digest.hexdigest()


def _source_zup_mm_to_gltf_yup_meters() -> np.ndarray:
    """Exact node transform for source Z-up millimetres to glTF Y-up metres."""
    return np.array(
        [
            [0.001, 0.0, 0.0, 0.0],
            [0.0, 0.0, 0.001, 0.0],
            [0.0, -0.001, 0.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )


def _srgb_to_linear_u8(rgba: np.ndarray) -> np.ndarray:
    rgb = rgba[..., :3].astype(np.float64) / 255.0
    linear = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    result = np.empty_like(rgba, dtype=np.uint8)
    result[..., :3] = np.rint(np.clip(linear, 0, 1) * 255).astype(np.uint8)
    result[..., 3] = rgba[..., 3]
    return result


def export_colored_glb(mesh: trimesh.Trimesh, colors_srgb: np.ndarray, output_path: str | Path) -> dict[str, Any]:
    """Write COLOR_0 GLB and prove canonical oriented float32 triangle equality."""
    rgba = np.asarray(colors_srgb)
    if rgba.shape != (len(mesh.vertices), 4) or rgba.dtype != np.uint8:
        raise ValueError("colors_srgb must be uint8 RGBA with one row per source vertex")
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    source_fingerprint = _canonical_triangle_fingerprint(mesh)
    colored = mesh.copy()
    # glTF vertex color components are linear. Decode sRGB explicitly before
    # assigning uint8 values; image samples and the API contract remain sRGB.
    colored.visual.vertex_colors = _srgb_to_linear_u8(rgba)
    try:
        scene = trimesh.Scene()
        scene.add_geometry(colored, geom_name="source_mesh", node_name="source_zup_mm")
        # Standard glTF scene space is Y-up/metres. Keep the source geometry
        # itself untouched in its local Z-up/mm coordinates and express the
        # conversion as a node transform: X rotation -90 degrees, then mm->m.
        scene.graph.update(
            frame_from=scene.graph.base_frame,
            frame_to="source_zup_mm",
            matrix=_source_zup_mm_to_gltf_yup_meters(),
            geometry="source_mesh",
        )
        scene.export(path, file_type="glb")
        reloaded = trimesh.load(path, force="scene", process=False)
    except Exception as exc:
        raise RuntimeError("could not export and reimport colored GLB") from exc
    if len(reloaded.geometry) != 1 or len(reloaded.graph.nodes_geometry) != 1:
        raise RuntimeError("GLB geometry validation failed: expected one source mesh node")
    exported_node = next(iter(reloaded.graph.nodes_geometry))
    exported_transform, exported_geometry_name = reloaded.graph.get(exported_node)
    reloaded_local_mesh = reloaded.geometry[exported_geometry_name]
    exported_fingerprint = _canonical_triangle_fingerprint(reloaded_local_mesh)
    equal = source_fingerprint == exported_fingerprint
    transform_equal = bool(np.allclose(exported_transform, _source_zup_mm_to_gltf_yup_meters(), atol=1e-9, rtol=0))
    if not equal or not transform_equal:
        raise RuntimeError(
            "GLB geometry validation failed: local triangles or Z-up/mm to Y-up/metre scene transform changed"
        )
    return {
        "geometry_equal": True,
        "fingerprint_scope": "oriented_triangle_coordinates_float32",
        "source_triangle_fingerprint_sha256": source_fingerprint,
        "exported_triangle_fingerprint_sha256": exported_fingerprint,
        "source_faces": int(len(mesh.faces)),
        "exported_faces": int(len(reloaded_local_mesh.faces)),
        "source_vertices": int(len(mesh.vertices)),
        "exported_vertices": int(len(reloaded_local_mesh.vertices)),
        "source_frame_geometry_equal": equal,
        "scene_transform_equal": transform_equal,
        "scene_transform_source_zup_mm_to_gltf_yup_meters": _source_zup_mm_to_gltf_yup_meters().tolist(),
        "geometry_validation": "canonical oriented triangle coordinate multiset in source-local Z-up/mm frame; float32 GLB position scope",
        "coordinate_frame": "source mesh local frame Z-up/mm; GLB node transform converts scene to Y-up/metres",
    }


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_input_image(path: Path) -> tuple[str, tuple[int, int]]:
    if not path.is_file() or path.stat().st_size > MAX_IMAGE_BYTES:
        raise ValueError("each source image must exist and be no larger than 5 MiB")
    with Image.open(path) as image:
        image.verify()
    with Image.open(path) as image:
        width, height = image.size
        if width * height > MAX_IMAGE_PIXELS:
            raise ValueError("each source image must be no larger than 12 megapixels")
        if image.mode not in ("RGB", "RGBA", "L", "LA", "P"):
            image = image.convert("RGBA")
        # Decode now while the source is still under the CLI limits.
        image.load()
        if image.mode in ("L", "LA", "P"):
            image = image.convert("RGBA")
        return _sha256_file(path), (width, height)


def _safe_id(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", value) or ".." in value:
        raise ValueError("experiment id must be a safe 1-64 character ASCII id")
    return value


def run_experiment(args: argparse.Namespace) -> dict[str, Any]:
    source = Path(args.source_stl)
    if not source.is_file() or source.stat().st_size > MAX_SOURCE_BYTES:
        raise ValueError("source STL must exist and be no larger than 25 MiB")
    expected_sha = args.source_sha256.lower()
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha):
        raise ValueError("source_sha256 must be a full 64-character SHA-256")
    source_sha = _sha256_file(source)
    if source_sha != expected_sha:
        raise ValueError("source STL SHA-256 does not match --source-sha256")
    view_paths = {"front": Path(args.front), "side": Path(args.side), "back": Path(args.back)}
    view_hashes: dict[str, str] = {}
    dimensions: dict[str, tuple[int, int]] = {}
    views: dict[str, Image.Image] = {}
    for name, path in view_paths.items():
        view_hashes[name], dimensions[name] = _validate_input_image(path)
        views[name] = Image.open(path).convert("RGBA")

    mesh = trimesh.load(source, force="mesh", process=False)
    if len(mesh.faces) > MAX_FACES:
        raise ValueError(f"source mesh exceeds CPU face budget of {MAX_FACES}")
    # Explicit, uncalibrated camera orientation convention. Side image faces
    # toward the left edge in the reference guide, hence camera at +X.
    cameras = {
        "front": {"position": (0, -1, 0), "up": (0, 0, 1)},
        "back": {"position": (0, 1, 0), "up": (0, 0, 1)},
        "side": {"position": (1, 0, 0), "up": (0, 0, 1)},
    }
    colors, color_report = project_colors(mesh, views, cameras)
    experiment_id = _safe_id(args.experiment_id)
    output_dir = Path(args.output_root) / experiment_id
    output_dir.mkdir(parents=True, exist_ok=True)
    glb_path = output_dir / "colored.glb"
    proof = export_colored_glb(mesh, colors, glb_path)
    report: dict[str, Any] = {
        "schema_version": 1,
        "experiment_id": experiment_id,
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "engine": "numpy/trimesh/Pillow CPU; trimesh RayMeshIntersector first-hit rays",
        "versions": {"python": sys.version.split()[0], "numpy": np.__version__, "scipy": scipy.__version__, "trimesh": trimesh.__version__, "pillow": PIL.__version__},
        "inputs": {
            "source_stl_sha256": source_sha,
            "source_stl_bytes": source.stat().st_size,
            "source_faces": int(len(mesh.faces)),
            "source_vertices": int(len(mesh.vertices)),
            "views_sha256": view_hashes,
            "view_dimensions_width_height": {name: list(size) for name, size in dimensions.items()},
        },
        "camera_orientations": {
            "front": {"position": [0, -1, 0], "up": [0, 0, 1]},
            "back": {"position": [0, 1, 0], "up": [0, 0, 1]},
            "side": {"position": [1, 0, 0], "up": [0, 0, 1]},
        },
        "color_projection": color_report,
        "glb_geometry_validation": proof,
        "artifact": "colored.glb",
        "limitations": [
            "vertex colors only; no UV texture atlas",
            "uncalibrated bounding-box orthographic projection; not true camera reprojection",
            "sampled image appearance is not recovered physical material or albedo",
            "unknown, transparent, occluded, and unobserved vertices remain neutral gray",
            "vertex colors follow glTF linear COLOR_0; image samples were decoded from sRGB",
        ],
        "validation_scopes": {
            "geometry": proof["geometry_validation"],
            "color": "vertex assignment coverage and finite RGBA values only; no perceptual acceptance claim",
            "projection": "uncalibrated bbox alignment only",
        },
    }
    report_path = output_dir / "color-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-stl", required=True)
    parser.add_argument("--source-sha256", required=True)
    parser.add_argument("--front", required=True, help="front RGB/RGBA PNG/JPEG")
    parser.add_argument("--side", required=True, help="side RGB/RGBA PNG/JPEG")
    parser.add_argument("--back", required=True, help="back RGB/RGBA PNG/JPEG")
    parser.add_argument("--experiment-id", required=True)
    parser.add_argument("--output-root", default="data/color-experiments")
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        report = run_experiment(_parser().parse_args(argv))
    except (ValueError, RuntimeError, OSError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps({"experiment_id": report["experiment_id"], "coverage": report["color_projection"]["vertex_coverage"], "geometry_equal": report["glb_geometry_validation"]["geometry_equal"], "artifacts": ["colored.glb", "color-report.json"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
