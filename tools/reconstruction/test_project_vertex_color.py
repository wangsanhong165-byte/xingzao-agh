from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
import trimesh
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from project_vertex_color import export_colored_glb, project_colors  # noqa: E402
from project_vertex_color import main


def test_cli_invalid_hash_reports_a_bounded_error_instead_of_a_missing_exception_class(capsys):
    result = main(["--source-stl", "missing-experiment.stl", "--source-sha256", "bad",
                   "--front", "missing-front.png", "--side", "missing-side.png", "--back", "missing-back.png",
                   "--experiment-id", "invalid-input"])
    assert result == 2
    assert '"error"' in capsys.readouterr().err


def _quad(y: float, color_normal: str = "front") -> trimesh.Trimesh:
    # This winding has normal -Y, toward the front camera at y < 0.
    vertices = np.array(
        [[-1, y, -1], [1, y, -1], [1, y, 1], [-1, y, 1]], dtype=float
    )
    faces = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.int64)
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    if color_normal == "back":
        mesh.invert()
    return mesh


def _view(rgb: tuple[int, int, int], *, alpha: bool = True) -> Image.Image:
    mode = "RGBA" if alpha else "RGB"
    pixel = (*rgb, 255) if alpha else rgb
    return Image.new(mode, (9, 9), pixel)


def _camera(direction: tuple[float, float, float]) -> dict[str, tuple[float, float, float]]:
    return {"position": direction, "up": (0, 0, 1)}


def test_front_camera_at_negative_y_colors_front_facing_vertices():
    mesh = _quad(0)
    colors, report = project_colors(
        mesh,
        {"front": _view((230, 30, 20))},
        {"front": _camera((0, -1, 0))},
    )

    assert np.all(colors[:, :3] == [230, 30, 20])
    assert report["colored_vertices"] == 4
    assert report["unknown_vertices"] == 0


def test_fully_occluded_rear_quad_stays_neutral_and_is_counted_unknown():
    visible = _quad(-0.5)
    occluded = _quad(0.5)
    mesh = trimesh.util.concatenate([visible, occluded])
    colors, report = project_colors(
        mesh,
        {"front": _view((230, 30, 20))},
        {"front": _camera((0, -1, 0))},
    )

    assert np.all(colors[:4, :3] == [230, 30, 20])
    assert np.all(colors[4:, :3] == [128, 128, 128])
    assert report["unknown_vertices"] == 4


def test_transparent_image_pixels_do_not_create_color_coverage():
    mesh = _quad(0)
    image = _view((0, 255, 0))
    pixels = np.asarray(image).copy()
    pixels[..., 3] = 0
    transparent = Image.fromarray(pixels, "RGBA")

    colors, report = project_colors(
        mesh,
        {"front": transparent},
        {"front": _camera((0, -1, 0))},
    )

    assert np.all(colors[:, :3] == [128, 128, 128])
    assert report["colored_vertices"] == 0
    assert report["unknown_vertices"] == 4


def test_other_camera_directions_choose_only_their_facing_surface():
    mesh = _quad(0, color_normal="back")
    colors, report = project_colors(
        mesh,
        {"back": _view((10, 40, 220))},
        {"back": _camera((0, 1, 0))},
    )

    assert np.all(colors[:, :3] == [10, 40, 220])
    assert report["colored_vertices"] == 4


def test_rgb_white_background_is_excluded_by_edge_connected_mask():
    mesh = _quad(0)
    pixels = np.full((9, 9, 3), 255, dtype=np.uint8)
    pixels[3:6, 3:6] = [20, 180, 30]
    image = Image.fromarray(pixels, "RGB")

    colors, report = project_colors(
        mesh,
        {"front": image},
        {"front": _camera((0, -1, 0))},
    )

    assert np.all(colors[:, :3] == [20, 180, 30])
    assert report["colored_vertices"] == 4


def test_mesh_positions_and_oriented_triangles_are_not_modified():
    mesh = _quad(0)
    before_vertices = mesh.vertices.copy()
    before_faces = mesh.faces.copy()
    project_colors(
        mesh,
        {"front": _view((50, 60, 70))},
        {"front": _camera((0, -1, 0))},
    )

    np.testing.assert_array_equal(mesh.vertices, before_vertices)
    np.testing.assert_array_equal(mesh.faces, before_faces)


def test_cameras_with_nonfinite_or_zero_direction_are_rejected():
    with pytest.raises(ValueError, match="camera"):
        project_colors(
            _quad(0),
            {"front": _view((1, 2, 3))},
            {"front": _camera((0, 0, 0))},
        )


def test_glb_export_reimports_with_identical_oriented_float32_triangles(tmp_path):
    mesh = _quad(0)
    before_vertices = mesh.vertices.copy()
    before_faces = mesh.faces.copy()
    colors = np.tile(np.array([20, 40, 60, 255], dtype=np.uint8), (4, 1))
    output = tmp_path / "colored.glb"

    proof = export_colored_glb(mesh, colors, output)
    reloaded = trimesh.load(output, force="scene", process=False)
    node = next(iter(reloaded.graph.nodes_geometry))
    transform, geometry_name = reloaded.graph.get(node)
    reloaded_mesh = reloaded.geometry[geometry_name]

    assert proof["geometry_equal"] is True
    assert proof["fingerprint_scope"] == "oriented_triangle_coordinates_float32"
    np.testing.assert_array_equal(reloaded_mesh.vertices, before_vertices.astype(np.float32))
    np.testing.assert_array_equal(reloaded_mesh.faces, before_faces)
    expected_transform = np.array(
        [[0.001, 0, 0, 0], [0, 0, 0.001, 0], [0, -0.001, 0, 0], [0, 0, 0, 1]]
    )
    np.testing.assert_allclose(transform, expected_transform, atol=1e-9, rtol=0)
    assert np.all(reloaded_mesh.visual.vertex_colors[:, :3] == [2, 5, 12])
