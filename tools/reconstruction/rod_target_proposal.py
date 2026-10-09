"""Derive a bounded, reviewable proposal for one selected straight circular rod."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

import numpy as np
import trimesh

from local_rod_repair_v2 import (
    DATA,
    FIT_TOLERANCE_MM,
    MAX_BYTES,
    MAX_FACES,
    MAX_REQUEST_BYTES,
    _valid_mesh,
    inspect_rod,
    _loop_distance,
    _point_triangle_distance_sq,
)

ROOT = Path(__file__).resolve().parents[2]
MAX_AXIS_EVENTS = 256
_SHA = re.compile(r"^[0-9a-f]{64}$")
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
_REQUEST_KEYS = {
    "sourceStlPath", "expectedSourceSha256", "pointInSourceMm", "axis",
    "maxRadialGrowthMm", "maxAddedVolumeMm3",
}


def _fail(code: str) -> None:
    raise ValueError(code)


def _finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _path_no_links(path: Path, root: Path) -> bool:
    try:
        relative = path.absolute().relative_to(root.absolute())
    except ValueError:
        return False
    if root.is_symlink() or (hasattr(root, "is_junction") and root.is_junction()):
        return False
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
            return False
    return True


def _request_directory(request_path: Path) -> Path:
    base = DATA / "rod-proposals"
    if not _path_no_links(request_path, DATA):
        _fail("ROD_PROPOSAL_PATH_INVALID")
    try:
        relative = request_path.resolve(strict=True).relative_to(base.resolve(strict=True))
    except (OSError, ValueError):
        _fail("ROD_PROPOSAL_PATH_INVALID")
    if len(relative.parts) != 2 or not _UUID.fullmatch(relative.parts[0]) or relative.parts[1] != "request.json":
        _fail("ROD_PROPOSAL_PATH_INVALID")
    if request_path.is_symlink() or not request_path.is_file() or request_path.stat().st_size > MAX_REQUEST_BYTES:
        _fail("ROD_PROPOSAL_REQUEST_INVALID")
    return request_path.parent.resolve(strict=True)


def _source_path(value: Any) -> Path:
    if not isinstance(value, str) or not value:
        _fail("ROD_PROPOSAL_SOURCE_INVALID")
    path = Path(value)
    if not path.is_absolute() or not _path_no_links(path, DATA):
        _fail("ROD_PROPOSAL_SOURCE_INVALID")
    try:
        resolved = path.resolve(strict=True)
        resolved.relative_to(DATA.resolve(strict=True))
    except (OSError, ValueError):
        _fail("ROD_PROPOSAL_SOURCE_INVALID")
    if not resolved.is_file() or resolved.stat().st_size > MAX_BYTES:
        _fail("ROD_PROPOSAL_SOURCE_INVALID")
    return resolved


def _load_request(request_path: Path) -> tuple[dict[str, Any], bytes, Path]:
    directory = _request_directory(request_path)
    raw = request_path.read_bytes()
    try:
        request = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise ValueError("ROD_PROPOSAL_REQUEST_INVALID") from exc
    if not isinstance(request, dict) or set(request) != _REQUEST_KEYS:
        _fail("ROD_PROPOSAL_REQUEST_INVALID")
    if request["axis"] not in ("x", "y", "z"):
        _fail("ROD_PROPOSAL_REQUEST_INVALID")
    if (not isinstance(request["expectedSourceSha256"], str) or
            not _SHA.fullmatch(request["expectedSourceSha256"])):
        _fail("ROD_PROPOSAL_REQUEST_INVALID")
    point = request["pointInSourceMm"]
    if not isinstance(point, list) or len(point) != 3 or any(not _finite_number(value) for value in point):
        _fail("ROD_PROPOSAL_REQUEST_INVALID")
    growth, volume = request["maxRadialGrowthMm"], request["maxAddedVolumeMm3"]
    if not _finite_number(growth) or not 0 < growth <= 1 or not _finite_number(volume) or not 0 < volume <= 10000:
        _fail("ROD_PROPOSAL_REQUEST_INVALID")
    return request, raw, directory


def _section(mesh: trimesh.Trimesh, axis: int, axial: float, *,
             click: np.ndarray | None = None, center_hint: np.ndarray | None = None,
             radius_hint: float | None = None) -> tuple[np.ndarray, np.ndarray, float] | None:
    origin = np.zeros(3, dtype=np.float64)
    origin[axis] = axial
    try:
        section = mesh.section(plane_origin=origin, plane_normal=np.eye(3)[axis])
    except Exception:
        return None
    if section is None:
        return None
    other = [coordinate for coordinate in range(3) if coordinate != axis]
    local = []
    for loop in section.discrete:
        candidate = np.asarray(loop, dtype=np.float64)[:, other]
        if len(candidate) < 2 or not np.isfinite(candidate).all():
            return None
        if click is not None and _loop_distance(candidate, click) <= FIT_TOLERANCE_MM + 1e-6:
            local.append(candidate)
        elif center_hint is not None and radius_hint is not None and _loop_distance(candidate, center_hint) <= radius_hint + FIT_TOLERANCE_MM:
            local.append(candidate)
    if len(local) != 1:
        return None
    points = local[0]
    if (len(points) < 12 or not np.isfinite(points).all() or
            float(np.linalg.norm(points[0] - points[-1])) > FIT_TOLERANCE_MM):
        return None
    # Algebraic least-squares fit: x^2+y^2 + A*x + B*y + C = 0.
    matrix = np.column_stack((2 * points[:, 0], 2 * points[:, 1], np.ones(len(points))))
    rhs = np.einsum("ij,ij->i", points, points)
    try:
        fitted, *_ = np.linalg.lstsq(matrix, rhs, rcond=None)
    except np.linalg.LinAlgError:
        return None
    center = fitted[:2]
    radius_sq = float(fitted[2] + center @ center)
    if not np.isfinite(center).all() or not math.isfinite(radius_sq) or radius_sq <= 0:
        return None
    radius = math.sqrt(radius_sq)
    residual = np.abs(np.linalg.norm(points - center, axis=1) - radius)
    if float(residual.max()) > FIT_TOLERANCE_MM:
        return None
    origin[other] = center
    if not bool(mesh.contains(origin.reshape(1, 3))[0]):
        return None
    return center, points, radius


def _circle_at_point(mesh: trimesh.Trimesh, point: np.ndarray, axis: int) -> tuple[np.ndarray, float]:
    others = [coordinate for coordinate in range(3) if coordinate != axis]
    fitted = _section(mesh, axis, float(point[axis]), click=point[others])
    if fitted is None:
        _fail("ROD_TARGET_NOT_CIRCULAR")
    center_2d, _points, radius = fitted
    others = [coordinate for coordinate in range(3) if coordinate != axis]
    point_radius = float(np.linalg.norm(point[others] - center_2d))
    scale_epsilon = max(1e-6, float(np.max(np.abs(mesh.bounds))) * 1e-7)
    if abs(point_radius - radius) > FIT_TOLERANCE_MM + scale_epsilon:
        _fail("ROD_TARGET_CLICK_OFF_SURFACE")
    center = point.copy()
    center[others] = center_2d
    return center, radius


def _axis_events(mesh: trimesh.Trimesh, axis: int, center: np.ndarray, radius: float) -> np.ndarray:
    other = [i for i in range(3) if i != axis]
    triangles = np.asarray(mesh.triangles, dtype=np.float64)
    projected = triangles[:, :, other] - center[other]
    distances = _point_triangle_distance_sq(projected)
    relevant = triangles[distances <= (radius + FIT_TOLERANCE_MM + 1e-6) ** 2]
    return np.unique(relevant[:, :, axis])


def _qualifies(mesh: trimesh.Trimesh, axis: int, axial: float,
               center: np.ndarray, radius: float) -> bool:
    other = [coordinate for coordinate in range(3) if coordinate != axis]
    fitted = _section(mesh, axis, axial, center_hint=center[other], radius_hint=radius)
    if fitted is None:
        return False
    found_center, _points, found_radius = fitted
    other = [coordinate for coordinate in range(3) if coordinate != axis]
    return (abs(found_radius - radius) <= FIT_TOLERANCE_MM and
            float(np.linalg.norm(found_center - center[other])) <= FIT_TOLERANCE_MM)


def _maximal_segment(mesh: trimesh.Trimesh, axis: int, point: np.ndarray,
                     center: np.ndarray, radius: float, events: np.ndarray) -> tuple[float, float]:
    if len(events) < 2 or point[axis] <= events[0] or point[axis] >= events[-1]:
        _fail("ROD_TARGET_CAP_OR_BOUNDARY")
    selected = int(np.searchsorted(events, point[axis], side="right") - 1)
    checked = 0
    def qualifies(index: int) -> bool:
        nonlocal checked
        checked += 1
        if checked > MAX_AXIS_EVENTS:
            _fail("ROD_TARGET_TOO_MANY_AXIS_EVENTS")
        return _qualifies(mesh, axis, float((events[index] + events[index + 1]) / 2), center, radius)
    if selected < 0 or selected >= len(events) - 1 or not qualifies(selected):
        _fail("ROD_TARGET_NOT_STRAIGHT_CIRCULAR")
    first = last = selected
    while first > 0 and qualifies(first - 1):
        first -= 1
    while last + 1 < len(events) - 1 and qualifies(last + 1):
        last += 1
    start, end = float(events[first]), float(events[last + 1])
    # Clicks on an axial cap are ambiguous even when they happen to be on its rim.
    end_epsilon = max(1e-6, float(np.max(np.abs(mesh.bounds))) * 1e-7)
    if point[axis] - start <= end_epsilon or end - point[axis] <= end_epsilon:
        _fail("ROD_TARGET_CAP_OR_BOUNDARY")
    return start, end


def _normalized_spec(mesh: trimesh.Trimesh, request: dict[str, Any],
                     center: np.ndarray, radius: float, start: float, end: float) -> dict[str, Any]:
    axis = "xyz".index(request["axis"])
    others = [coordinate for coordinate in range(3) if coordinate != axis]
    center_start, center_end = center.copy(), center.copy()
    center_start[axis], center_end[axis] = start, end
    source_bounds = np.asarray(mesh.bounds, dtype=np.float64)
    allowed_low, allowed_high = center_start.copy(), center_start.copy()
    growth_margin = radius + float(request["maxRadialGrowthMm"]) + 0.03
    for coordinate in others:
        allowed_low[coordinate] = max(source_bounds[0, coordinate], center[coordinate] - growth_margin)
        allowed_high[coordinate] = min(source_bounds[1, coordinate], center[coordinate] + growth_margin)
        if not allowed_low[coordinate] < center[coordinate] < allowed_high[coordinate]:
            _fail("ROD_TARGET_BOUNDS_INVALID")
    allowed_low[axis], allowed_high[axis] = start, end
    return {
        "axis": request["axis"],
        "centerLineMm": [center_start.tolist(), center_end.tolist()],
        "allowedBoundsMm": [allowed_low.tolist(), allowed_high.tolist()],
        "maxRadialGrowthMm": float(request["maxRadialGrowthMm"]),
        "maxAddedVolumeMm3": float(request["maxAddedVolumeMm3"]),
    }


def run_request(request_path: Path) -> dict[str, Any]:
    request, _request_bytes, _directory = _load_request(request_path)
    source_path = _source_path(request["sourceStlPath"])
    source_bytes = source_path.read_bytes()
    source_sha = hashlib.sha256(source_bytes).hexdigest()
    if source_sha != request["expectedSourceSha256"]:
        _fail("ROD_PROPOSAL_SOURCE_HASH_MISMATCH")
    try:
        mesh = trimesh.load_mesh(file_obj=source_path, file_type="stl", process=True)
    except Exception as exc:
        raise ValueError("ROD_MESH_INVALID") from exc
    mesh = _valid_mesh(mesh)
    if len(mesh.faces) > MAX_FACES:
        _fail("ROD_MESH_INVALID")
    axis = "xyz".index(request["axis"])
    point = np.asarray(request["pointInSourceMm"], dtype=np.float64)
    center, radius = _circle_at_point(mesh, point, axis)
    events = _axis_events(mesh, axis, center, radius)
    start, end = _maximal_segment(mesh, axis, point, center, radius, events)
    spec = _normalized_spec(mesh, request, center, radius, start, end)
    inspection = inspect_rod(mesh, spec)
    return {
        "schema": "rod-target-proposal/v1",
        "sourceSha256": source_sha,
        "helperSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "spec": spec,
        "inspection": inspection,
        "scope": "axis-aligned-circular-rod-proposal",
        "physicalPrintVerified": False,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True, help="request.json inside data/rod-proposals/<uuid>/")
    args = parser.parse_args(argv)
    try:
        result = run_request(Path(args.request))
    except (OSError, ValueError) as exc:
        code = str(exc) or "ROD_PROPOSAL_FAILED"
        print(code, file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
