"""Deterministic local voxel probes for critical source-mesh features."""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.metadata
import json
import math
import os
import re
import stat
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any

import numpy as np
import trimesh


class FeatureProbeError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


_ROOT = Path(__file__).resolve().parents[2]
_HEX64 = re.compile(r"^[0-9a-fA-F]{64}$")
_SAFE_JOB = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def _version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return "unknown"


def _finite_vector(value: Any, length: int) -> bool:
    if not isinstance(value, (list, tuple)) or len(value) != length:
        return False
    try:
        return all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in value)
    except (TypeError, ValueError, OverflowError):
        return False


def _validate_features(features: Any, mesh_bounds: np.ndarray) -> list[dict[str, Any]]:
    if not isinstance(features, list) or not 1 <= len(features) <= 4:
        raise FeatureProbeError("FEATURES_INVALID")
    seen: set[str] = set()
    result = []
    for f in features:
        if not isinstance(f, dict):
            raise FeatureProbeError("FEATURE_INVALID")
        fid, kind = f.get("id"), f.get("kind")
        if not isinstance(fid, str) or not fid.isascii() or not 1 <= len(fid) <= 40 or fid in seen:
            raise FeatureProbeError("FEATURE_ID_INVALID")
        seen.add(fid)
        if kind not in ("solid", "void-channel"):
            raise FeatureProbeError("FEATURE_KIND_INVALID")
        bounds = f.get("boundsMm")
        if not isinstance(bounds, list) or len(bounds) != 2 or not all(_finite_vector(v, 3) for v in bounds):
            raise FeatureProbeError("FEATURE_BOUNDS_INVALID")
        lo, hi = np.asarray(bounds, dtype=np.float64)
        if np.any(hi <= lo) or np.any(lo < mesh_bounds[0]) or np.any(hi > mesh_bounds[1]):
            raise FeatureProbeError("FEATURE_BOUNDS_INVALID")
        retention = f.get("minRetention")
        if isinstance(retention, bool) or not isinstance(retention, (int, float)) or not math.isfinite(retention) or not 0.5 <= retention <= 1.0:
            raise FeatureProbeError("FEATURE_RETENTION_INVALID")
        surface_tolerance = f.get("surfaceToleranceMm", 0.05)
        if (isinstance(surface_tolerance, bool) or not isinstance(surface_tolerance, (int, float))
                or not math.isfinite(surface_tolerance) or not 0.0 <= surface_tolerance <= 0.1):
            raise FeatureProbeError("FEATURE_SURFACE_TOLERANCE_INVALID")
        axis = f.get("axis")
        if axis is not None and axis not in ("x", "y", "z"):
            raise FeatureProbeError("FEATURE_AXIS_INVALID")
        item = {"id": fid, "kind": kind, "boundsMm": [[float(x) for x in v] for v in bounds],
                "minRetention": float(retention), "surfaceToleranceMm": float(surface_tolerance)}
        if axis is not None:
            item["axis"] = axis
        result.append(item)
    return result


def _dimensions(value: Any) -> tuple[int, int, int]:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise FeatureProbeError("GRID_INVALID")
    dims = []
    for x in value:
        if isinstance(x, bool) or not isinstance(x, int) or not 4 <= x <= 32:
            raise FeatureProbeError("GRID_INVALID")
        dims.append(x)
    if math.prod(dims) > 32768:
        raise FeatureProbeError("GRID_INVALID")
    return tuple(dims)


def _mesh_is_valid(mesh: Any) -> None:
    if not isinstance(mesh, trimesh.Trimesh) or len(mesh.faces) == 0 or len(mesh.vertices) == 0:
        raise FeatureProbeError("MESH_INVALID")
    if len(mesh.faces) > 250_000:
        raise FeatureProbeError("MESH_TOO_LARGE")
    if not np.isfinite(mesh.vertices).all() or not np.isfinite(mesh.faces).all():
        raise FeatureProbeError("MESH_NONFINITE")
    if not mesh.is_watertight:
        raise FeatureProbeError("MESH_NOT_WATERTIGHT")
    if not mesh.is_winding_consistent:
        raise FeatureProbeError("MESH_WINDING_INVALID")
    if not math.isfinite(float(mesh.volume)) or float(mesh.volume) <= 0:
        raise FeatureProbeError("MESH_VOLUME_INVALID")


def _mask_bytes(mask: np.ndarray) -> str:
    # A Fortran-order flatten makes x the fastest-changing coordinate.
    return base64.b64encode(np.asarray(mask, dtype=np.uint8).ravel(order="F").tobytes()).decode("ascii")


def _surface_point_bytes(mask: np.ndarray, points: np.ndarray) -> str:
    return base64.b64encode(np.asarray(points, dtype="<f8").reshape(-1, 3).tobytes(order="C")).decode("ascii")


def _ray_first_hits(mesh: trimesh.Trimesh, origins: np.ndarray, directions: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Cast bounded-memory ray batches and return first hit per input ray."""
    origins = np.asarray(origins, dtype=np.float64).reshape(-1, 3)
    directions = np.asarray(directions, dtype=np.float64).reshape(-1, 3)
    if len(origins) != len(directions):
        raise FeatureProbeError("RAY_INPUT_INVALID")
    hits = np.full_like(origins, np.nan)
    found = np.zeros(len(origins), dtype=bool)
    try:
        for start in range(0, len(origins), 4096):
            end = min(start + 4096, len(origins))
            locations, ray_ids, _ = mesh.ray.intersects_location(
                ray_origins=origins[start:end], ray_directions=directions[start:end], multiple_hits=False)
            if len(ray_ids):
                ray_ids = np.asarray(ray_ids, dtype=np.int64)
                valid = (ray_ids >= 0) & (ray_ids < end - start)
                hits[start + ray_ids[valid]] = np.asarray(locations, dtype=np.float64)[valid]
                found[start + ray_ids[valid]] = True
    except Exception as exc:
        raise FeatureProbeError("RAYCAST_FAILED") from exc
    return hits, found


def _channel_masks(mesh: trimesh.Trimesh, core: np.ndarray, centers: np.ndarray,
                   lo: np.ndarray, hi: np.ndarray, step: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    dims = core.shape
    nx, ny, nz = dims
    max_rays = 3 * math.prod(dims) + 2 * (ny * nz + nx * nz + nx * ny)
    if max_rays > 110_000:
        raise FeatureProbeError("VOID_RAY_LIMIT")
    free = ~core
    edges_flat = np.zeros(math.prod(dims), dtype=np.uint8)
    boundary_flat = np.zeros(math.prod(dims), dtype=np.uint8)
    center_flat = np.column_stack([centers[..., axis].ravel(order="F") for axis in range(3)])
    for axis in range(3):
        low = [slice(None)] * 3
        high = [slice(None)] * 3
        low[axis] = slice(0, dims[axis] - 1)
        high[axis] = slice(1, dims[axis])
        pairs = free[tuple(low)] & free[tuple(high)]
        pair_ids = np.flatnonzero(pairs.ravel(order="F"))
        if not len(pair_ids):
            continue
        pair_shape = list(dims)
        pair_shape[axis] -= 1
        coords = np.unravel_index(pair_ids, tuple(pair_shape), order="F")
        lower_coords = [np.asarray(c) for c in coords]
        upper_coords = [np.asarray(c) for c in coords]
        upper_coords[axis] = upper_coords[axis] + 1
        lower_ids = np.ravel_multi_index(tuple(lower_coords), dims, order="F")
        upper_ids = np.ravel_multi_index(tuple(upper_coords), dims, order="F")
        ray_dirs = np.zeros((len(lower_ids), 3), dtype=np.float64)
        ray_dirs[:, axis] = 1.0
        hit_points, found = _ray_first_hits(mesh, center_flat[lower_ids], ray_dirs)
        delta = np.where(found[:, None], hit_points - center_flat[lower_ids], 0.0)
        hit_distance = np.sum(delta * ray_dirs, axis=1)
        clear = ~found | (hit_distance >= step[axis] - 1e-7)
        edges_flat[lower_ids[clear]] |= np.uint8(1 << axis)

    for direction in range(6):
        axis = direction // 2
        positive = direction % 2 == 1
        boundary_index = dims[axis] - 1 if positive else 0
        boundary_selector = np.zeros(dims, dtype=bool)
        selector = [slice(None)] * 3
        selector[axis] = boundary_index
        boundary_selector[tuple(selector)] = True
        candidate = free & boundary_selector
        cell_ids = np.flatnonzero(candidate.ravel(order="F"))
        if not len(cell_ids):
            continue
        ray_dirs = np.zeros((len(cell_ids), 3), dtype=np.float64)
        ray_dirs[:, axis] = 1.0 if positive else -1.0
        hit_points, found = _ray_first_hits(mesh, center_flat[cell_ids], ray_dirs)
        delta = np.where(found[:, None], hit_points - center_flat[cell_ids], 0.0)
        hit_distance = np.sum(delta * ray_dirs, axis=1)
        clear = ~found | (hit_distance >= step[axis] / 2.0 - 1e-7)
        boundary_flat[cell_ids[clear]] |= np.uint8(1 << direction)
    return edges_flat.reshape(dims, order="F"), boundary_flat.reshape(dims, order="F")


def build_probes(mesh: trimesh.Trimesh, features: list[dict[str, Any]],
                 grid_dimensions: tuple[int, int, int] = (20, 20, 24),
                 source_sha256: str = "0" * 64) -> dict[str, Any]:
    """Build source occupancy and real-surface masks at feature-grid cell centers."""
    _mesh_is_valid(mesh)
    np.random.seed(0)
    if not isinstance(source_sha256, str) or not _HEX64.fullmatch(source_sha256):
        raise FeatureProbeError("SOURCE_HASH_INVALID")
    dims = _dimensions(grid_dimensions)
    valid_features = _validate_features(features, np.asarray(mesh.bounds, dtype=np.float64))
    outputs = []
    for feature in valid_features:
        lo, hi = np.asarray(feature["boundsMm"], dtype=np.float64)
        step = (hi - lo) / np.asarray(dims, dtype=np.float64)
        # Include one full cell of context on each side so ROI edges cannot
        # masquerade as mesh surfaces.
        axes = [lo[i] + (np.arange(dims[i] + 2, dtype=np.float64) - 0.5) * step[i] for i in range(3)]
        xx, yy, zz = np.meshgrid(*axes, indexing="ij")
        points = np.column_stack((xx.ravel(order="F"), yy.ravel(order="F"), zz.ravel(order="F")))
        try:
            occupied_halo = np.asarray(mesh.contains(points), dtype=bool).reshape(tuple(d + 2 for d in dims), order="F")
        except Exception as exc:
            raise FeatureProbeError("MESH_CONTAINS_FAILED") from exc
        core = occupied_halo[1:-1, 1:-1, 1:-1]
        exposed_by_direction = np.zeros(dims + (6,), dtype=bool)
        for axis in range(3):
            low = [slice(1, d + 1) for d in dims]
            high = [slice(1, d + 1) for d in dims]
            low[axis] = slice(0, dims[axis])
            high[axis] = slice(2, dims[axis] + 2)
            exposed_by_direction[..., axis * 2] = core & ~occupied_halo[tuple(low)]
            exposed_by_direction[..., axis * 2 + 1] = core & ~occupied_halo[tuple(high)]
        center_axes = [lo[i] + (np.arange(dims[i], dtype=np.float64) + 0.5) * step[i] for i in range(3)]
        cx, cy, cz = np.meshgrid(*center_axes, indexing="ij")
        core_centers = np.column_stack((cx.ravel(order="F"), cy.ravel(order="F"), cz.ravel(order="F")))
        eps = min(0.01, float(np.min(step)) / 10.0)
        record_ids: list[np.ndarray] = []
        record_directions: list[np.ndarray] = []
        record_points: list[np.ndarray] = []
        exposure_flat = np.zeros(math.prod(dims), dtype=np.uint8)
        for direction in range(6):
            ids = np.flatnonzero(exposed_by_direction[..., direction].ravel(order="F"))
            if not len(ids):
                continue
            ray_dirs = np.zeros((len(ids), 3), dtype=np.float64)
            ray_dirs[:, direction // 2] = 1.0 if direction % 2 else -1.0
            hit_points, found = _ray_first_hits(mesh, core_centers[ids], ray_dirs)
            if not found.all():
                raise FeatureProbeError("SURFACE_RAY_HIT_MISSING")
            inward = hit_points - ray_dirs * eps
            if not np.isfinite(inward).all():
                raise FeatureProbeError("SURFACE_PROJECTION_INVALID")
            within_roi = np.all((inward >= lo) & (inward <= hi), axis=1)
            ids = ids[within_roi]
            inward = inward[within_roi]
            if len(ids):
                exposure_flat[ids] |= np.uint8(1 << direction)
                record_ids.append(ids.astype("<u4"))
                record_directions.append(np.full(len(ids), direction, dtype=np.uint8))
                record_points.append(inward)
        record_ids_array = np.concatenate(record_ids) if record_ids else np.empty(0, dtype="<u4")
        record_directions_array = np.concatenate(record_directions) if record_directions else np.empty(0, dtype=np.uint8)
        record_points_array = np.concatenate(record_points, axis=0) if record_points else np.empty((0, 3), dtype="<f8")
        exposure_mask = exposure_flat.reshape(dims, order="F")
        surface = exposure_mask != 0
        grid = {"dimensions": list(dims), "stepMm": [float(x) for x in step], "order": "x-fastest", "cellCenters": True}
        output_feature = {**feature, "grid": grid, "sampleCount": math.prod(dims),
                          "solidSampleCount": int(core.sum()), "surfaceSampleCount": int(surface.sum()),
                          "solidMaskBase64": _mask_bytes(core), "surfaceMaskBase64": _mask_bytes(surface),
                          "surfacePointCount": len(record_points_array),
                          "surfacePointsBase64": _surface_point_bytes(surface, record_points_array),
                          "surfacePointVoxelIndicesBase64": base64.b64encode(record_ids_array.tobytes()).decode("ascii"),
                          "surfacePointDirectionsBase64": base64.b64encode(record_directions_array.tobytes()).decode("ascii"),
                          "surfaceExposureMaskBase64": _mask_bytes(exposure_mask)}
        if feature["kind"] == "void-channel":
            void_edges, void_boundaries = _channel_masks(mesh, core, np.stack((cx, cy, cz), axis=-1), lo, hi, step)
            output_feature["voidEdgeMaskBase64"] = _mask_bytes(void_edges)
            output_feature["voidBoundaryMaskBase64"] = _mask_bytes(void_boundaries)
        outputs.append(output_feature)
    return {"schema": "source-feature-probes/v1", "sourceSha256": source_sha256.lower(),
            "sourceBoundsMm": np.asarray(mesh.bounds, dtype=np.float64).tolist(),
            "generator": {"method": "trimesh.contains-with-halo", "surfacePointMethod": "first-exit-per-exposed-direction",
                          "trimeshVersion": trimesh.__version__, "rtreeVersion": _version("rtree")},
            "features": outputs}


def _assert_no_symlink(path: Path, allow_missing_leaf: bool = False) -> None:
    absolute = Path(os.path.abspath(path))
    try:
        rel = absolute.relative_to(_ROOT)
    except ValueError as exc:
        raise FeatureProbeError("PATH_OUTSIDE_ALLOWED_ROOT") from exc
    current = _ROOT
    for index, part in enumerate(rel.parts):
        current = current / part
        try:
            mode = current.lstat().st_mode
        except FileNotFoundError:
            if allow_missing_leaf and index == len(rel.parts) - 1:
                return
            raise FeatureProbeError("PATH_INVALID")
        if stat.S_ISLNK(mode):
            raise FeatureProbeError("PATH_SYMLINK_FORBIDDEN")
    try:
        resolved = absolute.resolve(strict=not allow_missing_leaf)
        resolved.relative_to(_ROOT)
    except (OSError, ValueError) as exc:
        raise FeatureProbeError("PATH_OUTSIDE_ALLOWED_ROOT") from exc


def _secure_path(value: Any, base: Path, allow_missing_leaf: bool = False) -> Path:
    if not isinstance(value, str) or not Path(value).is_absolute():
        raise FeatureProbeError("PATH_INVALID")
    path = Path(os.path.abspath(value))
    try:
        path.relative_to(base)
    except ValueError as exc:
        raise FeatureProbeError("PATH_OUTSIDE_ALLOWED_ROOT") from exc
    _assert_no_symlink(path, allow_missing_leaf)
    return path


def _load_request(request_arg: str) -> None:
    request_path = _secure_path(request_arg, _ROOT / "data" / "critical-features")
    base = _ROOT / "data" / "critical-features"
    try:
        job = request_path.parent.relative_to(base).as_posix()
    except ValueError as exc:
        raise FeatureProbeError("REQUEST_PATH_INVALID") from exc
    if "/" in job or not (_SAFE_JOB.fullmatch(job) or _is_uuid(job)) or request_path.name != "request.json":
        raise FeatureProbeError("REQUEST_PATH_INVALID")
    if not stat.S_ISREG(request_path.lstat().st_mode) or request_path.stat().st_size > 65_536:
        raise FeatureProbeError("REQUEST_INVALID")
    try:
        request = json.loads(request_path.read_text(encoding="utf-8"))
    except (UnicodeError, json.JSONDecodeError, OSError) as exc:
        raise FeatureProbeError("REQUEST_INVALID") from exc
    if not isinstance(request, dict):
        raise FeatureProbeError("REQUEST_INVALID")
    job_dir = request_path.parent
    source = _secure_path(request.get("sourceStlPath"), _ROOT / "data")
    output = _secure_path(request.get("outputPath"), job_dir, allow_missing_leaf=True)
    if output.parent != job_dir or output == request_path or output.name != "probes.json":
        raise FeatureProbeError("OUTPUT_PATH_INVALID")
    if not stat.S_ISREG(source.lstat().st_mode) or source.stat().st_size > 25 * 1024 * 1024:
        raise FeatureProbeError("SOURCE_STL_INVALID")
    expected = request.get("expectedSourceSha256")
    if not isinstance(expected, str) or not _HEX64.fullmatch(expected):
        raise FeatureProbeError("SOURCE_HASH_INVALID")
    content = source.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    if digest.lower() != expected.lower():
        raise FeatureProbeError("SOURCE_HASH_MISMATCH")
    try:
        mesh = trimesh.load(source, file_type="stl", force="mesh", process=True)
    except Exception as exc:
        raise FeatureProbeError("SOURCE_STL_INVALID") from exc
    dimensions = request.get("gridDimensions", [20, 20, 24])
    result = build_probes(mesh, request.get("features"), dimensions, digest)
    payload = (json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
    fd, temp_name = tempfile.mkstemp(prefix=".probes-", suffix=".tmp", dir=job_dir)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, output)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
        return True
    except (ValueError, AttributeError):
        return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    args = parser.parse_args(argv)
    try:
        _load_request(args.request)
        return 0
    except FeatureProbeError as exc:
        print(exc.code, file=sys.stderr)
        return 2
    except Exception:
        print("FEATURE_PROBE_FAILED", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
