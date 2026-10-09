import hashlib
import json
import re
import subprocess
import sys
import uuid
from pathlib import Path

import numpy as np
import pytest
import trimesh

sys.path.insert(0, str(Path(__file__).parent))
from local_rod_repair import DATA
from scale_lamppost_case import create_lamppost

PYTHON = DATA / "reconstruction" / "env-torch-readonly" / "Scripts" / "python.exe"
SCRIPT = Path(__file__).with_name("rod_target_proposal.py")


class Case:
    def __init__(self, mesh):
        self.directory = DATA / "rod-proposals" / str(uuid.uuid4())
        self.directory.mkdir(parents=True)
        self.source = self.directory / "source.stl"
        mesh.export(self.source, file_type="stl")
        self.request_path = self.directory / "request.json"
        self.update_request({
            "sourceStlPath": str(self.source.resolve()),
            "expectedSourceSha256": hashlib.sha256(self.source.read_bytes()).hexdigest(),
            "pointInSourceMm": [-2.75, 0, 15],
            "axis": "z",
            "maxRadialGrowthMm": 0.2,
            "maxAddedVolumeMm3": 100,
        })

    def update_request(self, request):
        self.request_path.write_text(json.dumps(request), encoding="utf-8")

    def run(self):
        return subprocess.run([str(PYTHON), str(SCRIPT), "--request", str(self.request_path)],
                              capture_output=True, text=True, timeout=30)

    def cleanup(self):
        import shutil
        proposal_root = (DATA / "rod-proposals").resolve(strict=True)
        resolved = self.directory.resolve(strict=True)
        assert resolved.parent == proposal_root
        assert re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", resolved.name)
        assert not self.directory.is_symlink()
        assert not (hasattr(self.directory, "is_junction") and self.directory.is_junction())
        shutil.rmtree(resolved)


@pytest.fixture
def lamp_case():
    case = Case(create_lamppost())
    try:
        yield case
    finally:
        case.cleanup()


def test_cli_proposes_maximal_exposed_lamppost_rod_and_exact_safe_spec(lamp_case):
    result = lamp_case.run()

    assert result.returncode == 0, result.stderr
    proposal_json = json.loads(result.stdout)
    assert proposal_json["schema"] == "rod-target-proposal/v1"
    assert proposal_json["sourceSha256"] == hashlib.sha256(lamp_case.source.read_bytes()).hexdigest()
    assert proposal_json["helperSha256"] == hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
    assert proposal_json["scope"] == "axis-aligned-circular-rod-proposal"
    assert proposal_json["physicalPrintVerified"] is False
    assert proposal_json["spec"]["axis"] == "z"
    assert np.allclose(proposal_json["spec"]["centerLineMm"], [[-3, 0, 2], [-3, 0, 28]], atol=0.01)
    assert proposal_json["inspection"]["verified"] is True
    assert proposal_json["inspection"]["measuredRadiusMm"] == pytest.approx(0.25, abs=0.01)
    bounds = np.asarray(proposal_json["spec"]["allowedBoundsMm"])
    assert np.allclose(bounds[:, 0], [-3.48, -2.52], atol=0.02)
    assert np.allclose(bounds[:, 1], [-0.48, 0.48], atol=0.02)
    assert proposal_json["spec"]["maxAddedVolumeMm3"] <= 10000
    assert set(proposal_json["spec"]) == {
        "axis", "centerLineMm", "allowedBoundsMm", "maxRadialGrowthMm", "maxAddedVolumeMm3"
    }


def test_proposal_follows_selected_axis_after_permutation_and_translation():
    mesh = create_lamppost()
    transform = np.array([[0, 0, 1, 11], [1, 0, 0, -7], [0, 1, 0, 4], [0, 0, 0, 1]], dtype=float)
    mesh.apply_transform(transform)
    case = Case(mesh)
    case.update_request({
        "sourceStlPath": str(case.source.resolve()),
        "expectedSourceSha256": hashlib.sha256(case.source.read_bytes()).hexdigest(),
        "pointInSourceMm": [26, -9.75, 4],
        "axis": "x",
        "maxRadialGrowthMm": 0.2,
        "maxAddedVolumeMm3": 100,
    })
    try:
        result = case.run()
        assert result.returncode == 0, result.stderr
        body = json.loads(result.stdout)
        assert body["spec"]["axis"] == "x"
        assert np.allclose(body["spec"]["centerLineMm"], [[13, -10, 4], [39, -10, 4]], atol=0.01)
        assert body["inspection"]["verified"] is True
    finally:
        case.cleanup()


def test_rejects_wrong_axis_and_cap_click(lamp_case):
    request = json.loads(lamp_case.request_path.read_text(encoding="utf-8"))
    request["axis"] = "x"
    lamp_case.update_request(request)
    result = lamp_case.run()
    assert result.returncode != 0
    assert result.stderr.strip().isupper()

    request["axis"] = "z"
    request["pointInSourceMm"] = [-0.5, 0, 30]
    lamp_case.update_request(request)
    result = lamp_case.run()
    assert result.returncode != 0
    assert result.stderr.strip().isupper()


def test_rejects_click_far_from_measured_surface(lamp_case):
    request = json.loads(lamp_case.request_path.read_text(encoding="utf-8"))
    request["pointInSourceMm"] = [-2.7, 0, 15]
    lamp_case.update_request(request)
    result = lamp_case.run()
    assert result.returncode != 0
    assert result.stderr.strip().isupper()


def test_rejects_source_hash_change_before_proposal(lamp_case):
    request = json.loads(lamp_case.request_path.read_text(encoding="utf-8"))
    request["expectedSourceSha256"] = "0" * 64
    lamp_case.update_request(request)
    result = lamp_case.run()
    assert result.returncode != 0
    assert "HASH" in result.stderr.upper()


def test_rejects_closed_hollow_tube_even_when_click_lands_on_outer_wall():
    outer = trimesh.creation.cylinder(radius=1, height=20, sections=48)
    inner = trimesh.creation.cylinder(radius=0.65, height=20, sections=48)
    tube = trimesh.boolean.difference([outer, inner], engine="manifold")
    tube.apply_translation([2, -1, 0])
    case = Case(tube)
    case.update_request({
        "sourceStlPath": str(case.source.resolve()),
        "expectedSourceSha256": hashlib.sha256(case.source.read_bytes()).hexdigest(),
        "pointInSourceMm": [3, -1, 0],
        "axis": "z",
        "maxRadialGrowthMm": 0.2,
        "maxAddedVolumeMm3": 100,
    })
    try:
        result = case.run()
        assert result.returncode != 0
        assert result.stderr.strip().isupper()
    finally:
        case.cleanup()


def test_rejects_more_than_256_axis_events():
    sections = 16
    levels = np.linspace(0, 10, 260)
    angles = np.arange(sections) * (2 * np.pi / sections)
    vertices = np.array([[np.cos(a), np.sin(a), z] for z in levels for a in angles])
    faces = []
    for row in range(len(levels) - 1):
        for col in range(sections):
            nxt = (col + 1) % sections
            a, b = row * sections + col, row * sections + nxt
            c, d = (row + 1) * sections + col, (row + 1) * sections + nxt
            faces.extend([[a, b, c], [b, d, c]])
    bottom_center, top_center = len(vertices), len(vertices) + 1
    vertices = np.vstack([vertices, [0, 0, levels[0]], [0, 0, levels[-1]]])
    for col in range(sections):
        nxt = (col + 1) % sections
        faces.extend([[bottom_center, nxt, col], [top_center, (len(levels) - 1) * sections + col,
                                                       (len(levels) - 1) * sections + nxt]])
    mesh = trimesh.Trimesh(vertices=vertices, faces=np.asarray(faces), process=True)
    case = Case(mesh)
    case.update_request({
        "sourceStlPath": str(case.source.resolve()),
        "expectedSourceSha256": hashlib.sha256(case.source.read_bytes()).hexdigest(),
        "pointInSourceMm": [1, 0, 5],
        "axis": "z",
        "maxRadialGrowthMm": 0.2,
        "maxAddedVolumeMm3": 100,
    })
    try:
        result = case.run()
        assert result.returncode != 0
        assert result.stderr.strip().isupper()
    finally:
        case.cleanup()


def test_request_api_is_strict_about_exact_keys(lamp_case):
    request = json.loads(lamp_case.request_path.read_text(encoding="utf-8"))
    request["unrecognized"] = True
    lamp_case.update_request(request)
    result = lamp_case.run()
    assert result.returncode != 0
    assert result.stderr.strip().isupper()
