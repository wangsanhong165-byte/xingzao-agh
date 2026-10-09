"""Budgeted radius growth for one user-declared straight circular rod in an STL."""
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


ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
MAX_BYTES = 25 * 1024 * 1024
MAX_FACES = 250_000
MAX_REQUEST_BYTES = 64 * 1024
MAX_AXIS_EVENTS = 256
FIT_TOLERANCE_MM = 0.02
VOLUME_ABS_TOLERANCE_MM3 = 1e-7
_SHA = re.compile(r"^[0-9a-f]{64}$")
_JOB = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
_OUTPUT_DIR = re.compile(r"^(?:inspect|r0[1-3]|verify(?:-[A-Za-z0-9_-]{1,64})?)$")


def _fail(code: str) -> None:
    raise ValueError(code)


def _finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _spec(spec: Any) -> dict[str, Any]:
    if not isinstance(spec, dict) or set(spec) != {
        "axis", "centerLineMm", "allowedBoundsMm", "maxRadialGrowthMm", "maxAddedVolumeMm3"
    }:
        _fail("ROD_SPEC_INVALID")
    if spec["axis"] not in ("x", "y", "z"):
        _fail("ROD_SPEC_INVALID")
    for key in ("centerLineMm", "allowedBoundsMm"):
        value = spec[key]
        if (not isinstance(value, list) or len(value) != 2 or
                any(not isinstance(point, list) or len(point) != 3 or
                    any(not _finite_number(v) for v in point) for point in value)):
            _fail("ROD_SPEC_INVALID")
    lo, hi = spec["centerLineMm"]
    axis = "xyz".index(spec["axis"])
    if any(lo[i] != hi[i] for i in range(3) if i != axis) or hi[axis] <= lo[axis]:
        _fail("ROD_SPEC_INVALID")
    allowed_lo, allowed_hi = spec["allowedBoundsMm"]
    if any(allowed_lo[i] >= allowed_hi[i] for i in range(3)):
        _fail("ROD_SPEC_INVALID")
    if any(lo[i] < allowed_lo[i] or hi[i] > allowed_hi[i] for i in range(3)):
        _fail("ROD_SPEC_INVALID")
    growth, volume = spec["maxRadialGrowthMm"], spec["maxAddedVolumeMm3"]
    if not _finite_number(growth) or not 0 < growth <= 1 or not _finite_number(volume) or volume <= 0:
        _fail("ROD_SPEC_INVALID")
    return spec


def _valid_mesh(mesh: Any) -> trimesh.Trimesh:
    if (not isinstance(mesh, trimesh.Trimesh) or len(mesh.faces) == 0 or len(mesh.vertices) == 0 or
            len(mesh.faces) > MAX_FACES or not np.isfinite(mesh.vertices).all() or
            not mesh.is_watertight or not mesh.is_winding_consistent or
            not math.isfinite(float(mesh.volume)) or float(mesh.volume) <= 0):
        _fail("ROD_MESH_INVALID")
    return mesh


def _section_radii(mesh: trimesh.Trimesh, spec: dict[str, Any]) -> tuple[list[float], list[float]]:
    axis = "xyz".index(spec["axis"])
    others = [i for i in range(3) if i != axis]
    start, end = spec["centerLineMm"]
    center = np.asarray(start, dtype=np.float64)[others]
    radii: list[float] = []
    center_offsets: list[float] = []
    normal = np.eye(3)[axis]
    # Stay away from the declared endpoints and sample at least eight independent sections.
    for fraction in np.linspace(0.1, 0.9, 9):
        origin = np.asarray(start, dtype=np.float64)
        origin[axis] = start[axis] + fraction * (end[axis] - start[axis])
        section = mesh.section(plane_origin=origin, plane_normal=normal)
        if section is None:
            _fail("ROD_INSPECTION_FAILED")
        loops = section.discrete
        if len(loops) != 1:
            _fail("ROD_INSPECTION_FAILED")
        points3 = np.asarray(loops[0], dtype=np.float64)
        points2 = points3[:, others]
        if len(points2) < 12:
            _fail("ROD_INSPECTION_FAILED")
        centroid = points2.mean(axis=0)
        distances = np.linalg.norm(points2 - centroid, axis=1)
        radius = float(distances.mean())
        # A neighboring surface, non-circular profile, or off-axis bend must not be guessed through.
        if radius <= 0 or float(np.max(np.abs(distances - radius))) > FIT_TOLERANCE_MM:
            _fail("ROD_INSPECTION_FAILED")
        offset = float(np.linalg.norm(centroid - center))
        if offset > FIT_TOLERANCE_MM:
            _fail("ROD_INSPECTION_FAILED")
        radii.append(radius)
        center_offsets.append(offset)
    if max(radii) - min(radii) > FIT_TOLERANCE_MM:
        _fail("ROD_INSPECTION_FAILED")
    return radii, center_offsets


def _maximum_permitted_growth(spec: dict[str, Any], measured_radius: float) -> float:
    axis = "xyz".index(spec["axis"])
    others = [i for i in range(3) if i != axis]
    center = np.asarray(spec["centerLineMm"][0], dtype=np.float64)
    lo, hi = np.asarray(spec["allowedBoundsMm"], dtype=np.float64)
    aabb_radius = min(min(center[i] - lo[i], hi[i] - center[i]) for i in others)
    length = float(spec["centerLineMm"][1][axis] - spec["centerLineMm"][0][axis])
    volume_radius = math.sqrt(measured_radius ** 2 + spec["maxAddedVolumeMm3"] / (math.pi * length))
    return max(0.0, min(spec["maxRadialGrowthMm"], aabb_radius - measured_radius,
                        volume_radius - measured_radius))


def _point_triangle_distance_sq(triangles: np.ndarray) -> np.ndarray:
    """Vectorized distance from the origin to each projected 2D triangle."""
    a, b, c = triangles[:, 0], triangles[:, 1], triangles[:, 2]
    ab = b - a
    bc = c - b
    ca = a - c
    cross_ab = ab[:, 0] * (-a[:, 1]) - ab[:, 1] * (-a[:, 0])
    cross_bc = bc[:, 0] * (-b[:, 1]) - bc[:, 1] * (-b[:, 0])
    cross_ca = ca[:, 0] * (-c[:, 1]) - ca[:, 1] * (-c[:, 0])
    inside = ((cross_ab >= -1e-12) & (cross_bc >= -1e-12) & (cross_ca >= -1e-12)) | \
             ((cross_ab <= 1e-12) & (cross_bc <= 1e-12) & (cross_ca <= 1e-12))

    def edge_distance(start: np.ndarray, end: np.ndarray) -> np.ndarray:
        delta = end - start
        length_sq = np.einsum("ij,ij->i", delta, delta)
        numerator = -np.einsum("ij,ij->i", start, delta)
        t = np.divide(numerator, length_sq, out=np.zeros_like(numerator), where=length_sq > 1e-24)
        t = np.clip(t, 0.0, 1.0)
        closest = start + t[:, None] * delta
        return np.einsum("ij,ij->i", closest, closest)

    return np.where(inside, 0.0, np.minimum.reduce((edge_distance(a, b), edge_distance(b, c), edge_distance(c, a))))


def _check_axis_event_sections(mesh: trimesh.Trimesh, spec: dict[str, Any],
                               expected_radius: float, outer_radius: float) -> int:
    """Check every open slab between relevant mesh vertex-height events; never subsample events."""
    axis = "xyz".index(spec["axis"])
    others = [i for i in range(3) if i != axis]
    start, end = np.asarray(spec["centerLineMm"], dtype=np.float64)
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64)
    center = start[others]
    triangle_vertices = vertices[faces]
    axial = triangle_vertices[:, :, axis]
    projected = triangle_vertices[:, :, others] - center
    axial_relevant = (axial.max(axis=1) >= start[axis]) & (axial.min(axis=1) <= end[axis])
    projected_min = projected.min(axis=1)
    projected_max = projected.max(axis=1)
    bbox_distance = np.maximum(np.maximum(projected_min, -projected_max), 0.0)
    bbox_relevant = np.einsum("ij,ij->i", bbox_distance, bbox_distance) <= (outer_radius + 1e-8) ** 2
    possible = axial_relevant & bbox_relevant
    ids = np.flatnonzero(possible)
    relevant_triangles = projected[ids]
    if len(ids):
        triangle_distance = _point_triangle_distance_sq(relevant_triangles)
        ids = ids[triangle_distance <= (outer_radius + 1e-8) ** 2]

    values = [float(start[axis]), float(end[axis])]
    if len(ids):
        event_values = triangle_vertices[ids, :, axis].reshape(-1)
        values.extend(float(value) for value in event_values if start[axis] < value < end[axis])
    events = sorted(set(round(value, 9) for value in values))
    if len(events) > MAX_AXIS_EVENTS:
        _fail("ROD_INSPECTION_RESOURCE_LIMIT")
    normal = np.eye(3)[axis]
    for lower, upper in zip(events, events[1:]):
        if upper - lower <= 1e-8:
            continue
        origin = np.asarray(start, dtype=np.float64).copy()
        origin[axis] = (lower + upper) / 2
        section = mesh.section(plane_origin=origin, plane_normal=normal)
        if section is None or len(section.discrete) != 1:
            _fail("ROD_INSPECTION_FAILED")
        points = np.asarray(section.discrete[0], dtype=np.float64)[:, others]
        distances = np.linalg.norm(points - points.mean(axis=0), axis=1)
        if (len(points) < 12 or abs(float(distances.mean()) - expected_radius) > FIT_TOLERANCE_MM or
                float(np.max(np.abs(distances - distances.mean()))) > FIT_TOLERANCE_MM or
                float(np.linalg.norm(points.mean(axis=0) - center)) > FIT_TOLERANCE_MM):
            _fail("ROD_INSPECTION_FAILED")
    return len(events)


def _check_continuous_growth_clearance(mesh: trimesh.Trimesh, spec: dict[str, Any],
                                      measured_radius: float) -> int:
    """Reject pre-existing geometry in any volume the declared growth budget could add."""
    growth = _maximum_permitted_growth(spec, measured_radius)
    inner_radius = measured_radius + FIT_TOLERANCE_MM
    outer_radius = measured_radius + growth
    event_count = _check_axis_event_sections(mesh, spec, measured_radius, outer_radius)
    if outer_radius <= inner_radius + 1e-9:
        return event_count
    try:
        outer = _oriented_cylinder(spec, outer_radius)
        inner = _oriented_cylinder(spec, inner_radius)
        shell = _boolean(outer, inner, "difference")
        overlap = _boolean(mesh, shell, "intersection")
    except ValueError as exc:
        raise ValueError("ROD_INSPECTION_FAILED") from exc
    overlap_volume = max(0.0, float(overlap.volume)) if len(overlap.faces) else 0.0
    tolerance = max(VOLUME_ABS_TOLERANCE_MM3, float(mesh.volume) * 1e-9)
    if overlap_volume > tolerance:
        _fail("ROD_INSPECTION_FAILED")
    return event_count


def inspect_rod(mesh: trimesh.Trimesh, spec: dict[str, Any]) -> dict[str, Any]:
    """Validate the declared target as one straight, near-circular, coaxial rod."""
    spec = _spec(spec)
    mesh = _valid_mesh(mesh)
    radii, offsets = _section_radii(mesh, spec)
    measured_radius = float(np.mean(radii))
    event_count = _check_continuous_growth_clearance(mesh, spec, measured_radius)
    components = mesh.split(only_watertight=False)
    if len(components) != 1:
        _fail("ROD_INSPECTION_FAILED")
    return {
        "verified": True,
        "measuredRadiusMm": measured_radius,
        "fitToleranceMm": FIT_TOLERANCE_MM,
        "sectionCount": len(radii),
        "axisEventCount": event_count,
        "sectionRadiusRangeMm": [float(min(radii)), float(max(radii))],
        "maxCenterlineOffsetMm": float(max(offsets)),
        "sourceComponents": len(components),
        "sourceBoundsMm": np.asarray(mesh.bounds, dtype=np.float64).tolist(),
        "sourceVolumeMm3": float(mesh.volume),
        "sourceTopology": {"watertight": bool(mesh.is_watertight), "windingConsistent": bool(mesh.is_winding_consistent)},
    }


def _oriented_cylinder(spec: dict[str, Any], radius: float) -> trimesh.Trimesh:
    start, end = np.asarray(spec["centerLineMm"], dtype=np.float64)
    axis = "xyz".index(spec["axis"])
    direction = np.eye(3)[axis]
    cylinder = trimesh.creation.cylinder(radius=radius, height=float(end[axis] - start[axis]), sections=128)
    rotation = trimesh.geometry.align_vectors([0.0, 0.0, 1.0], direction)
    cylinder.apply_transform(rotation)
    cylinder.apply_translation((start + end) / 2)
    return cylinder


def _boolean(a: trimesh.Trimesh, b: trimesh.Trimesh, operation: str) -> trimesh.Trimesh:
    try:
        result = getattr(trimesh.boolean, operation)([a, b], engine="manifold")
    except Exception as exc:
        raise ValueError("ROD_BOOLEAN_FAILED") from exc
    if not isinstance(result, trimesh.Trimesh):
        _fail("ROD_BOOLEAN_FAILED")
    return result


def repair_rod(mesh: trimesh.Trimesh, spec: dict[str, Any], radius_mm: float) -> trimesh.Trimesh:
    """Union a finite, axis-aligned cylinder into the original mesh without rebuilding it."""
    spec = _spec(spec)
    mesh = _valid_mesh(mesh)
    if not _finite_number(radius_mm) or radius_mm <= 0:
        _fail("ROD_RADIUS_INVALID")
    inspection = inspect_rod(mesh, spec)
    growth = float(radius_mm) - inspection["measuredRadiusMm"]
    if growth < -FIT_TOLERANCE_MM or growth > spec["maxRadialGrowthMm"] + 1e-9:
        _fail("ROD_REPAIR_BUDGET_EXCEEDED")
    cylinder = _oriented_cylinder(spec, float(radius_mm))
    candidate = _boolean(mesh, cylinder, "union")
    verify_rod_repair(mesh, candidate, spec, float(radius_mm))
    return candidate


def _mesh_difference(a: trimesh.Trimesh, b: trimesh.Trimesh) -> trimesh.Trimesh:
    result = _boolean(a, b, "difference")
    if not math.isfinite(float(result.volume)):
        _fail("ROD_REPAIR_VALIDATION_FAILED")
    return result


def _sample_surface_displacement(source: trimesh.Trimesh, candidate: trimesh.Trimesh) -> float:
    count = min(4096, max(256, len(source.faces)))
    points, _ = trimesh.sample.sample_surface(source, count)
    try:
        closest, distances, _ = trimesh.proximity.closest_point(candidate, points)
    except Exception as exc:
        raise ValueError("ROD_REPAIR_VALIDATION_FAILED") from exc
    if not np.isfinite(closest).all() or not np.isfinite(distances).all():
        _fail("ROD_REPAIR_VALIDATION_FAILED")
    return float(np.max(distances)) if len(distances) else 0.0


def _added_material_inside_requested_cylinder(added: trimesh.Trimesh,
                                             spec: dict[str, Any], radius_mm: float) -> bool:
    if not len(added.faces):
        return True
    axis = "xyz".index(spec["axis"])
    others = [i for i in range(3) if i != axis]
    start, end = np.asarray(spec["centerLineMm"], dtype=np.float64)
    vertices = np.asarray(added.vertices, dtype=np.float64)
    axial = vertices[:, axis]
    radial = np.linalg.norm(vertices[:, others] - start[others], axis=1)
    tolerance = 1e-5
    return bool(np.all(axial >= start[axis] - tolerance) and
                np.all(axial <= end[axis] + tolerance) and
                np.all(radial <= radius_mm + tolerance))


def verify_rod_repair(source: trimesh.Trimesh, candidate: trimesh.Trimesh,
                      spec: dict[str, Any], radius_mm: float) -> dict[str, Any]:
    """Independently recompute added/removed material, bounds, topology and sampled displacement."""
    spec = _spec(spec)
    source, candidate = _valid_mesh(source), _valid_mesh(candidate)
    if not _finite_number(radius_mm) or radius_mm <= 0:
        _fail("ROD_RADIUS_INVALID")
    inspection = inspect_rod(source, spec)
    expected = _boolean(source, _oriented_cylinder(spec, float(radius_mm)), "union")
    try:
        candidate_only = _mesh_difference(candidate, expected)
        expected_only = _mesh_difference(expected, candidate)
    except ValueError as exc:
        if str(exc) == "ROD_BOOLEAN_FAILED":
            raise ValueError("ROD_REPAIR_VALIDATION_FAILED") from exc
        raise
    candidate_only_volume = max(0.0, float(candidate_only.volume)) if len(candidate_only.faces) else 0.0
    expected_only_volume = max(0.0, float(expected_only.volume)) if len(expected_only.faces) else 0.0
    volume_tolerance = max(VOLUME_ABS_TOLERANCE_MM3, float(source.volume) * 1e-9)
    if candidate_only_volume > volume_tolerance or expected_only_volume > volume_tolerance:
        _fail("ROD_REPAIR_VALIDATION_FAILED")
    candidate_inspection = inspect_rod(candidate, spec)
    measured_growth = candidate_inspection["measuredRadiusMm"] - inspection["measuredRadiusMm"]
    if abs(candidate_inspection["measuredRadiusMm"] - float(radius_mm)) > FIT_TOLERANCE_MM:
        _fail("ROD_REPAIR_VALIDATION_FAILED")
    try:
        added = _mesh_difference(candidate, source)
        removed = _mesh_difference(source, candidate)
    except ValueError as exc:
        if str(exc) == "ROD_BOOLEAN_FAILED":
            raise ValueError("ROD_REPAIR_VALIDATION_FAILED") from exc
        raise
    added_volume = max(0.0, float(added.volume)) if len(added.faces) else 0.0
    removed_volume = max(0.0, float(removed.volume)) if len(removed.faces) else 0.0
    added_inside_cylinder = _added_material_inside_requested_cylinder(added, spec, float(radius_mm))
    allowed_lo, allowed_hi = np.asarray(spec["allowedBoundsMm"], dtype=np.float64)
    added_bounds = np.asarray(added.bounds, dtype=np.float64) if len(added.faces) else np.zeros((2, 3))
    displacement = _sample_surface_displacement(source, candidate)
    global_bounds_unchanged = bool(np.allclose(source.bounds, candidate.bounds, atol=1e-5, rtol=0))
    radial_pass = -FIT_TOLERANCE_MM <= measured_growth <= spec["maxRadialGrowthMm"] + FIT_TOLERANCE_MM
    bounds_pass = (np.all(added_bounds[0] >= allowed_lo - 1e-6)
                   and np.all(added_bounds[1] <= allowed_hi + 1e-6))
    budget_pass = (radial_pass and bounds_pass and added_volume <= spec["maxAddedVolumeMm3"] + volume_tolerance
                   and added_inside_cylinder
                   and removed_volume <= volume_tolerance and displacement <= spec["maxRadialGrowthMm"] + FIT_TOLERANCE_MM
                   and len(candidate.split(only_watertight=False)) == len(source.split(only_watertight=False))
                   and global_bounds_unchanged)
    validation = {
        "verified": bool(budget_pass),
        "radialGrowthMm": measured_growth,
        "candidateExpectedSymmetricDifferenceMm3": candidate_only_volume + expected_only_volume,
        "candidateExpectedDifferenceToleranceMm3": volume_tolerance,
        "addedVolumeMm3": added_volume,
        "removedVolumeMm3": removed_volume,
        "volumeToleranceMm3": volume_tolerance,
        "addedBoundsMm": added_bounds.tolist(),
        "addedWithinRequestedCylinder": added_inside_cylinder,
        "maxSampledDistanceMm": displacement,
        "distanceEvidence": "sampled-source-surface-to-candidate-surface-not-continuous-Hausdorff",
        "globalBoundsUnchanged": global_bounds_unchanged,
        "candidateComponents": len(candidate.split(only_watertight=False)),
        "sourceComponents": len(source.split(only_watertight=False)),
        "candidateTopology": {"watertight": bool(candidate.is_watertight), "windingConsistent": bool(candidate.is_winding_consistent)},
        "budgetChecks": {"radialGrowth": bool(radial_pass), "addedBounds": bool(bounds_pass),
                         "addedVolume": bool(added_volume <= spec["maxAddedVolumeMm3"] + volume_tolerance),
                         "addedWithinRequestedCylinder": added_inside_cylinder,
                         "removedVolumeZero": bool(removed_volume <= volume_tolerance),
                         "sampledDisplacement": bool(displacement <= spec["maxRadialGrowthMm"] + FIT_TOLERANCE_MM),
                         "globalBoundsUnchanged": global_bounds_unchanged},
    }
    if not validation["verified"]:
        _fail("ROD_REPAIR_BUDGET_EXCEEDED")
    return {"verified": True, "inspection": inspection, "candidateInspection": candidate_inspection, "validation": validation}


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _safe_data_file(value: Any) -> Path:
    if not isinstance(value, str) or not value:
        _fail("REPAIR_PATH_INVALID")
    path = Path(value)
    if not path.is_absolute():
        _fail("REPAIR_PATH_INVALID")
    raw = path.absolute()
    try:
        raw_rel = raw.relative_to(DATA.absolute())
    except ValueError:
        _fail("REPAIR_PATH_INVALID")
    current = DATA
    for part in raw_rel.parts:
        current = current / part
        if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
            _fail("REPAIR_PATH_INVALID")
    resolved = path.resolve(strict=True)
    try:
        resolved.relative_to(DATA.resolve(strict=True))
    except ValueError:
        _fail("REPAIR_PATH_INVALID")
    if not resolved.is_file() or resolved.stat().st_size > MAX_BYTES:
        _fail("REPAIR_PATH_INVALID")
    return resolved


def _load_stl(path: Path) -> tuple[trimesh.Trimesh, bytes]:
    data = path.read_bytes()
    if len(data) > MAX_BYTES:
        _fail("REPAIR_INPUT_TOO_LARGE")
    try:
        mesh = trimesh.load_mesh(file_obj=path, file_type="stl", process=True)
    except Exception as exc:
        raise ValueError("ROD_MESH_INVALID") from exc
    return _valid_mesh(mesh), data


def _request_paths(request_path: Path, output_dir: Any) -> Path:
    raw = request_path.absolute()
    try:
        raw_rel = raw.relative_to((DATA / "repair-jobs").absolute())
    except ValueError:
        _fail("REPAIR_PATH_INVALID")
    current = DATA / "repair-jobs"
    for part in raw_rel.parts:
        current = current / part
        if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
            _fail("REPAIR_PATH_INVALID")
    try:
        rel = request_path.resolve(strict=True).relative_to((DATA / "repair-jobs").resolve(strict=True))
    except (ValueError, FileNotFoundError):
        _fail("REPAIR_PATH_INVALID")
    if len(rel.parts) != 3 or not _JOB.fullmatch(rel.parts[0]) or not _OUTPUT_DIR.fullmatch(rel.parts[1]) or rel.parts[2] != "request.json":
        _fail("REPAIR_PATH_INVALID")
    if not isinstance(output_dir, str) or Path(output_dir).absolute() != request_path.parent.absolute():
        _fail("REPAIR_PATH_INVALID")
    return request_path.parent


def _run_request(request_path: Path) -> dict[str, Any]:
    output = _request_paths(request_path, str(request_path.parent.absolute()))
    if request_path.is_symlink() or request_path.stat().st_size > MAX_REQUEST_BYTES:
        _fail("REPAIR_REQUEST_INVALID")
    request_bytes = request_path.read_bytes()
    try:
        request = json.loads(request_bytes.decode("utf-8"))
    except Exception as exc:
        raise ValueError("REPAIR_REQUEST_INVALID") from exc
    if not isinstance(request, dict) or set(request) - {
        "mode", "sourceStlPath", "expectedSourceSha256", "candidateStlPath", "expectedCandidateSha256",
        "outputDir", "spec", "radiusMm"
    }:
        _fail("REPAIR_REQUEST_INVALID")
    if _request_paths(request_path, request.get("outputDir")) != output:
        _fail("REPAIR_PATH_INVALID")
    if (request.get("mode") not in ("inspect", "apply", "verify") or
            not isinstance(request.get("expectedSourceSha256"), str) or
            not _SHA.fullmatch(request["expectedSourceSha256"])):
        _fail("REPAIR_REQUEST_INVALID")
    spec = _spec(request.get("spec"))
    source_path = _safe_data_file(request.get("sourceStlPath"))
    source, source_bytes = _load_stl(source_path)
    source_sha = _sha(source_bytes)
    if source_sha != request["expectedSourceSha256"]:
        _fail("SOURCE_HASH_MISMATCH")
    mode = request["mode"]
    proof: dict[str, Any] = {"mode": mode, "sourceSha256": source_sha, "spec": spec,
                             "specSha256": _sha(json.dumps(spec, sort_keys=True, separators=(",", ":")).encode()),
                             "helperSha256": _sha(Path(__file__).read_bytes()),
                             "requestSha256": _sha(request_bytes)}
    if mode == "inspect":
        proof["inspection"] = inspect_rod(source, spec)
        proof["validation"] = {"verified": True, "scope": "supported-single-straight-circular-rod-and-source-topology"}
    elif mode == "apply":
        radius = request.get("radiusMm")
        candidate = repair_rod(source, spec, radius)
        candidate_path = output / "candidate.stl"
        if candidate_path.resolve() == source_path.resolve():
            _fail("REPAIR_PATH_INVALID")
        if candidate_path.is_symlink() or (hasattr(candidate_path, "is_junction") and candidate_path.is_junction()):
            _fail("REPAIR_PATH_INVALID")
        candidate.export(candidate_path, file_type="stl")
        candidate, candidate_bytes = _load_stl(candidate_path)
        candidate_sha = _sha(candidate_bytes)
        proof.update({"candidateSha256": candidate_sha, "radiusMm": radius,
                      **verify_rod_repair(source, candidate, spec, radius)})
    else:
        if not _SHA.fullmatch(request.get("expectedCandidateSha256", "")):
            _fail("REPAIR_REQUEST_INVALID")
        candidate_path = _safe_data_file(request.get("candidateStlPath"))
        if candidate_path.resolve() == source_path.resolve():
            _fail("REPAIR_PATH_INVALID")
        candidate, candidate_bytes = _load_stl(candidate_path)
        candidate_sha = _sha(candidate_bytes)
        if candidate_sha != request["expectedCandidateSha256"]:
            _fail("CANDIDATE_HASH_MISMATCH")
        radius = request.get("radiusMm")
        proof.update({"candidateSha256": candidate_sha, "radiusMm": radius,
                      **verify_rod_repair(source, candidate, spec, radius)})
    proof["schema"] = "local-rod-repair/v1"
    geometry_path = output / "geometry.json"
    if geometry_path.is_symlink() or (hasattr(geometry_path, "is_junction") and geometry_path.is_junction()):
        _fail("REPAIR_PATH_INVALID")
    geometry_path.write_text(json.dumps(proof, indent=2, sort_keys=True), encoding="utf-8")
    return proof


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    args = parser.parse_args(argv)
    try:
        result = _run_request(Path(args.request))
        sys.stdout.write(json.dumps({"success": True, "mode": result["mode"], "verified": result.get("verified", result.get("inspection", {}).get("verified", False))}) + "\n")
        return 0
    except Exception as exc:
        code = str(exc) if re.fullmatch(r"[A-Z0-9_]{1,64}", str(exc)) else "ROD_REPAIR_FAILED"
        sys.stderr.write(code + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
