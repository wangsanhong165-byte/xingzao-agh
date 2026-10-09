import base64
import json
from pathlib import Path
import sys
import uuid

import numpy as np
import pytest
import trimesh

sys.path.insert(0, str(Path(__file__).parent))
from feature_probes import FeatureProbeError, build_probes, main


def unpack(encoded, dims):
    raw = np.frombuffer(base64.b64decode(encoded), dtype=np.uint8)
    return raw.reshape((dims[2], dims[1], dims[0])).transpose(2, 1, 0)


def unpack_points(encoded, count):
    raw = np.frombuffer(base64.b64decode(encoded), dtype="<f8")
    return raw.reshape(count, 3)


def read_values(encoded, dtype):
    return np.frombuffer(base64.b64decode(encoded), dtype=dtype)


def feature(bounds, kind="solid", **extra):
    return {"id": "f1", "kind": kind, "boundsMm": bounds, "minRetention": 0.5, **extra}


def test_box_masks_follow_x_fastest_order_and_capture_boundary():
    mesh = trimesh.creation.box(extents=[2, 2, 2])
    result = build_probes(mesh, [feature([[-1, -1, -1], [1, 1, 1]])], (4, 4, 4), "a" * 64)
    item = result["features"][0]
    assert item["grid"]["order"] == "x-fastest"
    assert item["sampleCount"] == 64
    assert item["solidSampleCount"] == 64
    assert item["surfaceSampleCount"] == 56
    assert unpack(item["solidMaskBase64"], (4, 4, 4)).all()
    assert unpack(item["surfaceMaskBase64"], (4, 4, 4)).sum() == 56


def test_interior_roi_has_no_surface_cells():
    mesh = trimesh.creation.box(extents=[10, 10, 10])
    result = build_probes(mesh, [feature([[-1, -1, -1], [1, 1, 1]])], (4, 4, 4), "b" * 64)
    item = result["features"][0]
    assert item["solidSampleCount"] == 64
    assert item["surfaceSampleCount"] == 0
    assert item["surfacePointCount"] == 0
    assert not unpack_points(item["surfacePointsBase64"], 0).any()


def test_coarse_grid_surface_targets_are_projected_to_source_skin():
    mesh = trimesh.creation.box(extents=[20, 20, 20])
    result = build_probes(mesh, [feature([[-10, -10, -10], [10, 10, 10]])], (4, 4, 4), "d" * 64)
    item = result["features"][0]
    mask = unpack(item["surfaceMaskBase64"], (4, 4, 4)).ravel(order="F").astype(bool)
    points = unpack_points(item["surfacePointsBase64"], item["surfacePointCount"])
    voxel_ids = read_values(item["surfacePointVoxelIndicesBase64"], "<u4")
    directions = read_values(item["surfacePointDirectionsBase64"], "u1")
    exposure = unpack(item["surfaceExposureMaskBase64"], (4, 4, 4)).ravel(order="F")
    assert item["surfaceSampleCount"] == 56
    assert item["surfacePointCount"] == len(points) == 96
    assert len(voxel_ids) == len(directions) == len(points)
    assert np.all(np.bincount(directions, minlength=6) > 0)
    assert sum(int(value).bit_count() for value in exposure) == item["surfacePointCount"]
    assert len(set(zip(voxel_ids.tolist(), directions.tolist()))) == len(points)
    assert np.all(exposure[voxel_ids] & (1 << directions))
    targets = points
    assert np.all(np.isfinite(targets))
    # Each directional exit is inset from the corresponding box face.
    assert np.allclose(np.max(np.abs(targets), axis=1), 9.99, atol=1e-6)
    assert result["generator"]["surfacePointMethod"] == "first-exit-per-exposed-direction"


def test_thin_box_emits_sidewall_targets_in_addition_to_top_and_bottom():
    mesh = trimesh.creation.box(extents=[100, 100, 4.8])
    bounds = [[-50, -50, -2.4], [50, 50, 2.4]]
    result = build_probes(mesh, [feature(bounds)], (8, 8, 4), "f" * 64)
    item = result["features"][0]
    directions = read_values(item["surfacePointDirectionsBase64"], "u1")
    counts = np.bincount(directions, minlength=6)
    assert np.all(counts > 0)
    assert counts[0] == counts[1] == counts[2] == counts[3]
    assert counts[4] == counts[5] > 0
    assert item["surfacePointCount"] == len(directions)


def test_surface_projection_outside_feature_roi_clears_surface_target():
    mesh = trimesh.creation.box(extents=[20, 20, 20])
    result = build_probes(mesh, [feature([[8, -1, -1], [9.8, 1, 1]])], (4, 4, 4), "e" * 64)
    item = result["features"][0]
    assert item["surfaceSampleCount"] == 0
    assert not unpack(item["surfaceMaskBase64"], (4, 4, 4)).any()
    assert item["surfacePointCount"] == 0
    assert not unpack_points(item["surfacePointsBase64"], 0).any()


def test_void_channel_free_nodes_do_not_override_a_blocked_thin_wall_edge():
    parts = [
        trimesh.creation.box(extents=[1, 4, 4], transform=trimesh.transformations.translation_matrix([-1.5, 0, 0])),
        trimesh.creation.box(extents=[1, 4, 4], transform=trimesh.transformations.translation_matrix([1.5, 0, 0])),
        trimesh.creation.box(extents=[0.2, 4, 4]),
    ]
    mesh = trimesh.util.concatenate(parts)
    result = build_probes(mesh, [feature([[-2, -2, -2], [2, 2, 2]], kind="void-channel")], (8, 4, 4), "1" * 64)
    item = result["features"][0]
    solid = unpack(item["solidMaskBase64"], (8, 4, 4))
    edges = unpack(item["voidEdgeMaskBase64"], (8, 4, 4))
    boundaries = unpack(item["voidBoundaryMaskBase64"], (8, 4, 4))
    assert not solid[3, 1:3, 1:3].any() and not solid[4, 1:3, 1:3].any()
    assert not (edges[3, 1:3, 1:3] & 1).any()
    assert boundaries.dtype == np.uint8
    assert not (boundaries[2, 1:3, 1:3] & 1).any()
    assert not (boundaries[5, 1:3, 1:3] & 2).any()


def test_rejects_non_watertight_mesh():
    mesh = trimesh.creation.box()
    mesh.update_faces(np.arange(len(mesh.faces) - 2))
    with pytest.raises(FeatureProbeError, match="MESH_NOT_WATERTIGHT"):
        build_probes(mesh, [feature([[-0.4] * 3, [0.4] * 3])], source_sha256="c" * 64)


def test_rejects_grid_outside_contract():
    with pytest.raises(FeatureProbeError, match="GRID_INVALID"):
        build_probes(trimesh.creation.box(), [feature([[-0.4] * 3, [0.4] * 3])], (33, 4, 4), "c" * 64)


def test_rejects_nonfinite_feature_bounds():
    with pytest.raises(FeatureProbeError, match="FEATURE_BOUNDS_INVALID"):
        build_probes(trimesh.creation.box(), [feature([[float("nan"), -0.4, -0.4], [0.4] * 3])], source_sha256="c" * 64)


def test_surface_tolerance_defaults_and_round_trips_only_finite_numbers():
    mesh = trimesh.creation.box()
    defaulted = build_probes(mesh, [feature([[-0.4] * 3, [0.4] * 3])], source_sha256="2" * 64)
    assert defaulted["features"][0]["surfaceToleranceMm"] == 0.05
    explicit = build_probes(mesh, [feature([[-0.4] * 3, [0.4] * 3], surfaceToleranceMm=0.075)], source_sha256="2" * 64)
    assert explicit["features"][0]["surfaceToleranceMm"] == 0.075
    for invalid in (True, "0.05", float("nan"), -0.001, 0.1001):
        with pytest.raises(FeatureProbeError, match="FEATURE_SURFACE_TOLERANCE_INVALID"):
            build_probes(mesh, [feature([[-0.4] * 3, [0.4] * 3], surfaceToleranceMm=invalid)], source_sha256="2" * 64)


def test_cli_rejects_wrong_hash_and_path_escape(capsys):
    root = Path(__file__).resolve().parents[2]
    job = root / "data" / "critical-features" / f"pytest-{uuid.uuid4().hex}"
    job.mkdir(parents=True, exist_ok=True)
    stl = job / "source.stl"
    stl.write_bytes(trimesh.creation.box().export(file_type="stl"))
    request = job / "request.json"
    payload = {"sourceStlPath": str(stl), "expectedSourceSha256": "0" * 64,
               "outputPath": str(job / "probes.json"),
               "features": [feature([[-0.4] * 3, [0.4] * 3])], "gridDimensions": [4, 4, 4]}
    try:
        request.write_text(json.dumps(payload), encoding="utf-8")
        assert main(["--request", str(request)]) == 2
        assert "SOURCE_HASH_MISMATCH" in capsys.readouterr().err
        payload["expectedSourceSha256"] = "a" * 64
        payload["sourceStlPath"] = str(root / "README.md")
        request.write_text(json.dumps(payload), encoding="utf-8")
        assert main(["--request", str(request)]) == 2
        assert "PATH_OUTSIDE_ALLOWED_ROOT" in capsys.readouterr().err
    finally:
        request.unlink(missing_ok=True)
        stl.unlink(missing_ok=True)
        job.rmdir()
