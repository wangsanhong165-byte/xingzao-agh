"""Mechanical regressions for local rod validation amid unrelated geometry."""
import sys
from pathlib import Path

import numpy as np
import pytest
import trimesh

sys.path.insert(0, str(Path(__file__).parent))
import local_rod_repair_v2 as repair
from scale_lamppost_case import create_lamppost


def lamp_spec(**changes):
    value = {
        "axis": "z",
        "centerLineMm": [[-3.0, 0.0, 2.0], [-3.0, 0.0, 28.0]],
        "allowedBoundsMm": [[-3.65, -0.65, 2.0], [-2.35, 0.65, 28.0]],
        "maxRadialGrowthMm": 0.4,
        "maxAddedVolumeMm3": 40.0,
    }
    value.update(changes)
    return value


def test_collinear_projected_faces_use_actual_edge_distance():
    faces = np.array([[[10.0, 0.0], [11.0, 0.0], [11.0, 0.0]],
                      [[-1.0, 0.0], [1.0, 0.0], [1.0, 0.0]],
                      [[-1.0, -1.0], [1.0, -1.0], [0.0, 1.0]]])
    assert np.allclose(repair._point_triangle_distance_sq(faces), [100.0, 0.0, 0.0])


def complex_lamppost():
    lamp = create_lamppost()
    tower = trimesh.creation.cylinder(radius=2.0, height=30.0, sections=96)
    tower.apply_translation([3.0, 0.0, 15.0])
    crown = trimesh.creation.icosphere(subdivisions=3, radius=2.1)
    crown.apply_transform(trimesh.transformations.rotation_matrix(0.37, [1, 2, 0.5]))
    crown.apply_translation([3.0, 0.0, 30.4])
    result = trimesh.boolean.union([lamp, tower, crown], engine="manifold")
    assert result.is_watertight and result.is_winding_consistent
    assert len(result.split(only_watertight=False)) == 1
    assert len(np.unique(np.round(result.vertices[:, 2], 8))) > 256
    return result


def test_inspect_repair_verify_local_post_and_preserve_distant_structure():
    source = complex_lamppost()
    original = source.copy()
    spec = lamp_spec()

    inspected = repair.inspect_rod(source, spec)
    assert inspected["verified"] is True
    assert inspected["measuredRadiusMm"] == pytest.approx(0.25, abs=0.01)
    assert inspected["sourceComponents"] == 1

    candidate = repair.repair_rod(source, spec, 0.4)
    proof = repair.verify_rod_repair(original, candidate, spec, 0.4)
    assert proof["verified"] is True
    assert candidate.is_watertight and candidate.is_winding_consistent
    assert np.allclose(candidate.bounds, original.bounds, atol=1e-5)
    assert candidate.volume - original.volume == pytest.approx(
        np.pi * (0.4**2 - 0.25**2) * 26.0, rel=0.12
    )
    # The remote tower/crown must survive as solid volume, not merely preserve its AABB.
    remote_probe = trimesh.creation.box(extents=[1.0, 1.0, 1.0])
    remote_probe.apply_translation([3.0, 0.0, 15.0])
    assert len(trimesh.boolean.intersection([candidate, remote_probe], engine="manifold").faces) > 0
    assert np.allclose(source.vertices, original.vertices)


def test_inspection_rejects_hollow_tube_inner_wall_as_a_solid_rod():
    outer = trimesh.creation.cylinder(radius=1.0, height=20.0, sections=64)
    inner = trimesh.creation.cylinder(radius=0.65, height=20.2, sections=64)
    tube = trimesh.boolean.difference([outer, inner], engine="manifold")
    base = trimesh.creation.box(extents=[5.0, 5.0, 2.0])
    base.apply_translation([0.0, 0.0, -9.0])
    source = trimesh.boolean.union([tube, base], engine="manifold")
    spec = {
        "axis": "z",
        "centerLineMm": [[0.0, 0.0, -8.0], [0.0, 0.0, 8.0]],
        "allowedBoundsMm": [[-0.9, -0.9, -8.0], [0.9, 0.9, 8.0]],
        "maxRadialGrowthMm": 0.2,
        "maxAddedVolumeMm3": 100.0,
    }
    assert source.is_watertight and len(source.split(only_watertight=False)) == 1
    with pytest.raises(ValueError, match="ROD_INSPECTION_FAILED"):
        repair.inspect_rod(source, spec)


def test_inspection_rejects_thin_existing_obstacle_in_allowed_growth_shell():
    source = create_lamppost()
    # The fin overlaps the original post so the test remains one closed solid,
    # while its outer edge reaches into the proposed radius-0.65 growth shell.
    fin = trimesh.creation.box(extents=[0.42, 0.08, 0.18])
    fin.apply_translation([-2.77, 0.0, 15.0])
    obstructed = trimesh.boolean.union([source, fin], engine="manifold")
    assert obstructed.is_watertight and len(obstructed.split(only_watertight=False)) == 1
    with pytest.raises(ValueError, match="ROD_INSPECTION_FAILED"):
        repair.inspect_rod(obstructed, lamp_spec())
