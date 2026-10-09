"""Regression fixture for selecting one rod in a locally complex solid."""
import json
import sys
from pathlib import Path

import numpy as np
import pytest
import trimesh

sys.path.insert(0, str(Path(__file__).parent))
from scale_lamppost_case import create_lamppost
from test_rod_target_proposal import Case
from rod_target_proposal import _axis_events


def complex_lamppost():
    """Add a distant, faceted tower and crown without changing the target post."""
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


def test_cli_selects_target_post_despite_distant_contours_and_global_events():
    case = Case(complex_lamppost())
    try:
        result = case.run()
        assert result.returncode == 0, result.stderr
        body = json.loads(result.stdout)
        assert body["inspection"]["verified"] is True
        assert np.allclose(body["spec"]["centerLineMm"], [[-3, 0, 2], [-3, 0, 28]], atol=0.01)
        assert body["inspection"]["measuredRadiusMm"] == pytest.approx(0.25, abs=0.01)
    finally:
        case.cleanup()


def test_distant_collinear_projected_wall_does_not_add_local_axis_events():
    # Closed corrugated wall: the y=0 vertical side projects to a line through
    # the rod's center, but stays several millimeters away from the rod.
    z = np.linspace(1.0, 29.0, 301)
    x = 4.0 + 0.1 * (np.arange(len(z)) % 2)
    vertices = [[px, py, pz] for px, pz in zip(x, z)
                for px, py in [(2.0, 0.0), (px, 0.0), (px, 2.0), (2.0, 2.0)]]
    faces = [[0, 2, 1], [0, 3, 2]]
    for layer in range(len(z) - 1):
        for edge in range(4):
            a, b = 4 * layer + edge, 4 * layer + (edge + 1) % 4
            faces.extend([[a, b, b + 4], [a, b + 4, a + 4]])
    end = 4 * (len(z) - 1)
    faces.extend([[end, end + 1, end + 2], [end, end + 2, end + 3]])
    wall = trimesh.Trimesh(vertices=vertices, faces=faces)
    wall.fix_normals()
    mesh = trimesh.boolean.union([create_lamppost(), wall], engine='manifold')
    assert mesh.is_watertight and len(mesh.split(only_watertight=False)) == 1
    events = _axis_events(mesh, 2, np.array([-3.0, 0.0, 15.0]), 0.25)
    assert len(events) < 256
    case = Case(mesh)
    try:
        result = case.run()
        assert result.returncode == 0, result.stderr
        assert np.allclose(json.loads(result.stdout)['spec']['centerLineMm'], [[-3, 0, 2], [-3, 0, 28]], atol=0.01)
    finally:
        case.cleanup()
