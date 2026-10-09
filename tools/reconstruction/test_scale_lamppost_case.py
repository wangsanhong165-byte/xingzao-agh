import hashlib
import json
import sys
import uuid
from pathlib import Path

import numpy as np
import pytest
import trimesh

sys.path.insert(0, str(Path(__file__).parent))
from scale_lamppost_case import create_lamppost, main
from local_rod_repair import DATA, inspect_rod


def test_complete_lamppost_preserves_declared_geometry_and_inspectable_rod():
    mesh = create_lamppost()

    assert isinstance(mesh, trimesh.Trimesh)
    assert mesh.is_watertight
    assert mesh.is_winding_consistent
    assert mesh.volume > 0
    assert len(mesh.split(only_watertight=False)) == 1
    assert np.allclose(mesh.bounds, [[-6, -4, 0], [6, 4, 30]], atol=1e-6)

    # The center of the specified 2 mm through-hole is empty through the base.
    hole_probe = trimesh.creation.cylinder(radius=0.99, height=1.8, sections=96)
    hole_probe.apply_translation([3, 0, 1])
    overlap = trimesh.boolean.intersection([mesh, hole_probe], engine="manifold")
    assert len(overlap.faces) == 0 or overlap.volume == pytest.approx(0, abs=1e-8)

    declared = {
        "axis": "z",
        "centerLineMm": [[-3, 0, 2], [-3, 0, 28]],
        "allowedBoundsMm": [[-3.48, -0.48, 2], [-2.52, 0.48, 28]],
        "maxRadialGrowthMm": 0.2,
        "maxAddedVolumeMm3": 20,
    }
    result = inspect_rod(mesh, declared)
    assert result["verified"] is True
    assert result["measuredRadiusMm"] == pytest.approx(0.25, abs=0.01)
    assert result["sourceComponents"] == 1


@pytest.mark.parametrize("diameter", [0.3, 0.8, 1.2])
def test_parameterized_diameter_is_applied_to_rod(diameter):
    mesh = create_lamppost(diameter_mm=diameter)
    declared = {
        "axis": "z",
        "centerLineMm": [[-3, 0, 2], [-3, 0, 28]],
        "allowedBoundsMm": [[-3.48, -0.48, 2], [-2.52, 0.48, 28]],
        "maxRadialGrowthMm": 0.2,
        "maxAddedVolumeMm3": 20,
    }
    assert inspect_rod(mesh, declared)["measuredRadiusMm"] == pytest.approx(diameter / 2, abs=0.01)


@pytest.mark.parametrize("diameter", [True, False, 0, -0.1, 0.299, 1.201, float("nan"), float("inf"), -float("inf")])
def test_rejects_invalid_diameter(diameter):
    with pytest.raises(ValueError):
        create_lamppost(diameter_mm=diameter)


def test_cli_writes_hashed_source_and_exact_design_and_repair_declaration():
    case_dir = DATA / f"complete-lamppost-test-{uuid.uuid4()}"
    try:
        assert main(["--diameter-mm", "0.5", "--output-dir", str(case_dir)]) == 0
        source_path = case_dir / "source.stl"
        case_path = case_dir / "case.json"
        record = json.loads(case_path.read_text(encoding="utf-8"))
        assert source_path.is_file()
        assert record["sourceSha256"] == hashlib.sha256(source_path.read_bytes()).hexdigest()
        roundtrip = trimesh.load(source_path, force="mesh")
        assert roundtrip.is_watertight
        assert len(roundtrip.split(only_watertight=False)) == 1
        assert inspect_rod(roundtrip, record["repairSpec"])["verified"] is True
        assert record["dimensionsMm"] == {
            "base": [12, 8, 2], "rodDiameter": 0.5, "rodCenter": [-3, 0],
            "rodExposedZ": [2, 28], "lampDiameter": 5, "lampZ": [28, 30],
            "throughHole": {"center": [3, 0], "diameter": 2},
        }
        assert record["source"] == "team-original-parametric-design"
        assert record["sourceStlFile"] == "source.stl"
        assert record["repairSpec"] == {
            "axis": "z", "centerLineMm": [[-3, 0, 2], [-3, 0, 28]],
            "allowedBoundsMm": [[-3.48, -0.48, 2], [-2.52, 0.48, 28]],
            "maxRadialGrowthMm": 0.2, "maxAddedVolumeMm3": 20,
        }
        assert record["features"] == {
            "rod": {"boundsMm": [[-3.48, -0.48, 2], [-2.52, 0.48, 28]], "centerLineMm": [[-3, 0, 2], [-3, 0, 28]]},
            "rodEntityRoiMm": [[-3.3, -0.3, 2.25], [-2.7, 0.3, 27.75]],
            "throughHoleRoiMm": [[1.6, -1.4, 0.05], [4.4, 1.4, 1.95]],
            "throughHolePassThreshold": 0.9,
            "fixedFeatures": ["base", "through-hole", "lamp-head"],
        }

        assert main(["--diameter-mm", "0.5", "--output-dir", str(case_dir)]) == 1
    finally:
        if case_dir.exists():
            import shutil
            assert case_dir.resolve(strict=True).is_relative_to(DATA.resolve(strict=True))
            shutil.rmtree(case_dir)


def test_cli_requires_new_absolute_directory_inside_data():
    relative = "data/should-not-be-accepted"
    assert main(["--diameter-mm", "0.5", "--output-dir", relative]) == 1
    assert main(["--diameter-mm", "0.5", "--output-dir", str(Path(__file__).resolve().parent / "outside")]) == 1
