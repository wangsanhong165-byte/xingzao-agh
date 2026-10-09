import sys
import json
import shutil
import uuid
from pathlib import Path

import numpy as np
import pytest
import trimesh

sys.path.insert(0, str(Path(__file__).parent))
from local_rod_repair import DATA, inspect_rod, main, repair_rod, verify_rod_repair


def rod_source(radius=0.25):
    # Asymmetric, already-built body; this is only a geometry-level test input.
    body = trimesh.creation.box(extents=[8, 6, 2])
    body.apply_translation([1.0, -0.5, 1.0])
    pin = trimesh.creation.cylinder(radius=radius, height=3, sections=96)
    pin.apply_translation([2.0, 0.5, 3.5])
    result = trimesh.boolean.union([body, pin], engine="manifold")
    assert result.is_watertight
    return result


def spec(**overrides):
    value = {
        "axis": "z",
        "centerLineMm": [[2.0, 0.5, 2.0], [2.0, 0.5, 5.0]],
        "allowedBoundsMm": [[1.5, 0.0, 2.0], [2.5, 1.0, 5.0]],
        "maxRadialGrowthMm": 0.5,
        "maxAddedVolumeMm3": 4.0,
    }
    value.update(overrides)
    return value


def test_inspection_and_union_repair_keep_asymmetric_body_and_record_budget():
    source = rod_source()
    original = source.copy()
    inspection = inspect_rod(source, spec())
    assert inspection["verified"] is True
    assert inspection["measuredRadiusMm"] == pytest.approx(0.25, abs=0.01)
    assert inspection["fitToleranceMm"] <= 0.02
    assert inspection["sourceComponents"] == 1
    assert np.allclose(inspection["sourceBoundsMm"], original.bounds)

    candidate = repair_rod(source, spec(), 0.4)
    proof = verify_rod_repair(original, candidate, spec(), 0.4)
    assert proof["verified"] is True
    assert proof["validation"]["removedVolumeMm3"] <= proof["validation"]["volumeToleranceMm3"]
    assert proof["validation"]["addedVolumeMm3"] <= 4.0
    assert proof["validation"]["maxSampledDistanceMm"] <= 0.5 + 1e-6
    assert proof["validation"]["addedBoundsMm"][0][0] >= 1.5 - 1e-6
    assert proof["validation"]["addedBoundsMm"][1][0] <= 2.5 + 1e-6
    assert candidate.is_watertight and candidate.is_winding_consistent
    assert candidate.volume > original.volume
    assert np.allclose(source.vertices, original.vertices)


def test_rejects_insufficient_growth_or_added_volume_budget():
    source = rod_source()
    with pytest.raises(ValueError, match="ROD_REPAIR_BUDGET_EXCEEDED"):
        repair_rod(source, spec(maxRadialGrowthMm=0.05), 0.4)
    with pytest.raises(ValueError, match="ROD_REPAIR_BUDGET_EXCEEDED"):
        repair_rod(source, spec(maxAddedVolumeMm3=0.01), 0.4)


def test_repairs_parent_scale_pin_whose_bottom_is_coplanar_with_body_top():
    body = trimesh.creation.box(extents=[20, 18, 3])
    body.apply_translation([0, 0, 1.5])
    pin = trimesh.creation.cylinder(radius=0.25, height=2.0, sections=96)
    pin.apply_translation([5, 0, 4])
    source = trimesh.boolean.union([body, pin], engine="manifold")
    parent_spec = {
        "axis": "z", "centerLineMm": [[5, 0, 3], [5, 0, 5]],
        "allowedBoundsMm": [[4.5, -0.5, 3], [5.5, 0.5, 5]],
        "maxRadialGrowthMm": 0.2, "maxAddedVolumeMm3": 2,
    }
    assert inspect_rod(source, parent_spec)["measuredRadiusMm"] == pytest.approx(0.25, abs=0.01)
    candidate = repair_rod(source, parent_spec, 0.4)
    proof = verify_rod_repair(source, candidate, parent_spec, 0.4)
    assert proof["validation"]["verified"] is True
    assert proof["validation"]["globalBoundsUnchanged"] is True


def test_rejects_neighboring_component_in_target_sections():
    source = rod_source()
    neighbor = trimesh.creation.cylinder(radius=0.2, height=2.5, sections=64)
    neighbor.apply_translation([2.38, 0.5, 3.5])
    source = trimesh.boolean.union([source, neighbor], engine="manifold")
    with pytest.raises(ValueError, match="ROD_INSPECTION_FAILED"):
        inspect_rod(source, spec())


def test_rejects_bent_rod_and_invalid_spec():
    source = rod_source()
    bent = trimesh.creation.cylinder(radius=0.25, height=1.5, sections=64)
    bent.apply_translation([2.2, 0.5, 2.75])
    source = trimesh.boolean.union([source, bent], engine="manifold")
    with pytest.raises(ValueError, match="ROD_INSPECTION_FAILED"):
        inspect_rod(source, spec())
    with pytest.raises(ValueError, match="ROD_SPEC_INVALID"):
        inspect_rod(rod_source(), spec(maxRadialGrowthMm=True))


def test_independent_verification_rejects_tampered_candidate_and_out_of_bounds_addition():
    source = rod_source()
    candidate = repair_rod(source, spec(), 0.4)
    tampered = candidate.copy()
    extra = trimesh.creation.box(extents=[0.1, 0.1, 0.1])
    extra.apply_translation([0, 0, 4])
    tampered = trimesh.boolean.union([tampered, extra], engine="manifold")
    with pytest.raises(ValueError, match="ROD_(?:REPAIR_BUDGET_EXCEEDED|REPAIR_VALIDATION_FAILED|INSPECTION_FAILED)"):
        verify_rod_repair(source, tampered, spec(), 0.4)

    narrow = spec(allowedBoundsMm=[[1.9, 0.4, 2.0], [2.1, 0.6, 5.0]])
    with pytest.raises(ValueError, match="ROD_REPAIR_BUDGET_EXCEEDED"):
        verify_rod_repair(source, candidate, narrow, 0.4)


@pytest.mark.parametrize("declared_radius", [0.3, 5.0])
def test_independent_verification_requires_candidate_to_match_declared_radius(declared_radius):
    source = rod_source()
    candidate = repair_rod(source, spec(), 0.4)
    with pytest.raises(ValueError, match="ROD_REPAIR_VALIDATION_FAILED"):
        verify_rod_repair(source, candidate, spec(), declared_radius)


def test_inspection_rejects_neighbor_touching_the_rod_growth_shell_near_base():
    source = rod_source()
    neighbor = trimesh.creation.cylinder(radius=0.05, height=0.15, sections=64)
    neighbor.apply_translation([2.40, 0.5, 2.075])
    source_with_neighbor = trimesh.boolean.union([source, neighbor], engine="manifold")
    with pytest.raises(ValueError, match="ROD_INSPECTION_FAILED"):
        inspect_rod(source_with_neighbor, spec())


def test_inspection_rejects_tiny_neighbor_inside_the_clearance_tolerance_ring():
    source = rod_source()
    neighbor = trimesh.creation.cylinder(radius=0.004, height=0.15, sections=64)
    neighbor.apply_translation([2.265, 0.5, 2.075])
    source_with_neighbor = trimesh.boolean.union([source, neighbor], engine="manifold")
    with pytest.raises(ValueError, match="ROD_INSPECTION_FAILED"):
        inspect_rod(source_with_neighbor, spec())


def test_inspection_refuses_to_skip_when_axis_event_limit_is_exceeded():
    radial = 0.25
    around = 16
    levels = np.linspace(2.0, 5.0, 257)
    vertices = []
    for z in levels:
        for angle in np.linspace(0, 2 * np.pi, around, endpoint=False):
            vertices.append([2 + radial * np.cos(angle), 0.5 + radial * np.sin(angle), z])
    bottom_center = len(vertices)
    vertices.append([2, 0.5, 2])
    top_center = len(vertices)
    vertices.append([2, 0.5, 5])
    faces = []
    for level in range(len(levels) - 1):
        for side in range(around):
            nxt = (side + 1) % around
            a, b = level * around + side, level * around + nxt
            c, d = (level + 1) * around + nxt, (level + 1) * around + side
            faces.extend([[a, b, c], [a, c, d]])
    for side in range(around):
        nxt = (side + 1) % around
        faces.append([bottom_center, nxt, side])
        faces.append([top_center, (len(levels) - 1) * around + side,
                      (len(levels) - 1) * around + nxt])
    many_events = trimesh.Trimesh(vertices=np.asarray(vertices), faces=np.asarray(faces), process=True)
    assert many_events.is_watertight and many_events.is_winding_consistent
    with pytest.raises(ValueError, match="ROD_INSPECTION_RESOURCE_LIMIT"):
        inspect_rod(many_events, spec())


def test_independent_verification_rejects_unrelated_crossbar_inside_widened_aabb():
    source = rod_source()
    wide_spec = spec(allowedBoundsMm=[[1.5, 0.0, 2.0], [4.1, 1.0, 5.0]])
    candidate = repair_rod(source, wide_spec, 0.4)
    crossbar = trimesh.creation.box(extents=[1.75, 0.10, 0.04])
    crossbar.apply_translation([3.125, 0.5, 4.98])
    tampered = trimesh.boolean.union([candidate, crossbar], engine="manifold")
    with pytest.raises(ValueError, match="ROD_REPAIR_VALIDATION_FAILED"):
        verify_rod_repair(source, tampered, wide_spec, 0.4)


def test_cli_hashes_source_and_roundtripped_candidate_then_independently_verifies(capsys):
    source = rod_source()
    job_dir = DATA / "repair-jobs" / str(uuid.uuid4())
    (job_dir / "inspect").mkdir(parents=True)
    try:
        source_path = job_dir / "inspect" / "source.stl"
        source.export(source_path, file_type="stl")
        source_sha = __import__("hashlib").sha256(source_path.read_bytes()).hexdigest()
        apply_dir = job_dir / "r01"
        apply_dir.mkdir()
        apply_request = {
            "mode": "apply", "sourceStlPath": str(source_path), "expectedSourceSha256": source_sha,
            "outputDir": str(apply_dir), "spec": spec(), "radiusMm": 0.4,
        }
        request_path = apply_dir / "request.json"
        request_path.write_text(json.dumps(apply_request), encoding="utf-8")
        assert main(["--request", str(request_path)]) == 0
        apply_proof = json.loads((apply_dir / "geometry.json").read_text(encoding="utf-8"))
        assert apply_proof["sourceSha256"] == source_sha
        assert apply_proof["schema"] == "local-rod-repair/v1"
        assert apply_proof["candidateSha256"] == __import__("hashlib").sha256((apply_dir / "candidate.stl").read_bytes()).hexdigest()
        assert apply_proof["validation"]["verified"] is True

        verify_dir = job_dir / "verify-r01"
        verify_dir.mkdir()
        verify_request = {
            "mode": "verify", "sourceStlPath": str(source_path), "expectedSourceSha256": source_sha,
            "candidateStlPath": str(apply_dir / "candidate.stl"), "expectedCandidateSha256": apply_proof["candidateSha256"],
            "outputDir": str(verify_dir), "spec": spec(), "radiusMm": 0.4,
        }
        verify_path = verify_dir / "request.json"
        verify_path.write_text(json.dumps(verify_request), encoding="utf-8")
        assert main(["--request", str(verify_path)]) == 0
        verified = json.loads((verify_dir / "geometry.json").read_text(encoding="utf-8"))
        assert verified["candidateSha256"] == apply_proof["candidateSha256"]
        assert verified["validation"]["verified"] is True
        capsys.readouterr()
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


def test_cli_rejects_request_outside_fixed_job_tree():
    outside = Path(__file__)
    assert main(["--request", str(outside)]) == 1
