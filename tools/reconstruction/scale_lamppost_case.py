"""Create a complete, parametric tabletop lamppost geometry for validation."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

import trimesh


ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
SOURCE = "team-original-parametric-design"
DIMENSIONS: dict[str, Any] = {
    "base": [12, 8, 2],
    "rodCenter": [-3, 0],
    "rodExposedZ": [2, 28],
    "lampDiameter": 5,
    "lampZ": [28, 30],
    "throughHole": {"center": [3, 0], "diameter": 2},
}
REPAIR_SPEC: dict[str, Any] = {
    "axis": "z",
    "centerLineMm": [[-3, 0, 2], [-3, 0, 28]],
    "allowedBoundsMm": [[-3.48, -0.48, 2], [-2.52, 0.48, 28]],
    "maxRadialGrowthMm": 0.2,
    "maxAddedVolumeMm3": 20,
}
FEATURES: dict[str, Any] = {
    "rod": {
        "boundsMm": [[-3.48, -0.48, 2], [-2.52, 0.48, 28]],
        "centerLineMm": [[-3, 0, 2], [-3, 0, 28]],
    },
    "rodEntityRoiMm": [[-3.3, -0.3, 2.25], [-2.7, 0.3, 27.75]],
    "throughHoleRoiMm": [[1.6, -1.4, 0.05], [4.4, 1.4, 1.95]],
    "throughHolePassThreshold": 0.9,
    "fixedFeatures": ["base", "through-hole", "lamp-head"],
}


def _validate_diameter(diameter_mm: Any) -> float:
    if (isinstance(diameter_mm, bool) or not isinstance(diameter_mm, (int, float)) or
            not math.isfinite(diameter_mm) or not 0.3 <= diameter_mm <= 1.2):
        raise ValueError("ROD_DIAMETER_INVALID")
    return float(diameter_mm)


def _boolean(meshes: list[trimesh.Trimesh], operation: str) -> trimesh.Trimesh:
    try:
        result = getattr(trimesh.boolean, operation)(meshes, engine="manifold")
    except Exception as exc:
        raise ValueError("LAMPOST_BOOLEAN_FAILED") from exc
    if not isinstance(result, trimesh.Trimesh) or len(result.faces) == 0:
        raise ValueError("LAMPOST_BOOLEAN_FAILED")
    return result


def create_lamppost(diameter_mm: float = 0.5) -> trimesh.Trimesh:
    """Build a single watertight base, post, lamp-head body, and bored base."""
    diameter = _validate_diameter(diameter_mm)
    base = trimesh.creation.box(extents=[12, 8, 2])
    base.apply_translation([0, 0, 1])

    # The post spans the entire model height so it is physically united with
    # both the base and head; only z=2..28 remains externally visible.
    post = trimesh.creation.cylinder(radius=diameter / 2, height=30, sections=128)
    post.apply_translation([-3, 0, 15])

    lamp = trimesh.creation.cylinder(radius=2.5, height=2, sections=128)
    lamp.apply_translation([-3, 0, 29])
    body = _boolean([base, post, lamp], "union")

    bore = trimesh.creation.cylinder(radius=1, height=2.2, sections=128)
    bore.apply_translation([3, 0, 1])
    mesh = _boolean([body, bore], "difference")
    if (not mesh.is_watertight or not mesh.is_winding_consistent or mesh.volume <= 0 or
            len(mesh.split(only_watertight=False)) != 1):
        raise ValueError("LAMPOST_GEOMETRY_INVALID")
    return mesh


def _output_directory(raw_path: str) -> Path:
    path = Path(raw_path)
    if not path.is_absolute():
        raise ValueError("OUTPUT_DIR_MUST_BE_ABSOLUTE")
    resolved = path.resolve(strict=False)
    data_root = DATA.resolve(strict=True)
    try:
        resolved.relative_to(data_root)
    except ValueError as exc:
        raise ValueError("OUTPUT_DIR_OUTSIDE_DATA") from exc
    if resolved == data_root or resolved.exists():
        raise ValueError("OUTPUT_DIR_MUST_BE_NEW")
    return resolved


def write_case(output_dir: Path, diameter_mm: float = 0.5) -> dict[str, Any]:
    diameter = _validate_diameter(diameter_mm)
    output_dir = _output_directory(str(output_dir))
    mesh = create_lamppost(diameter)
    output_dir.mkdir(parents=True, exist_ok=False)
    source_path = output_dir / "source.stl"
    mesh.export(source_path, file_type="stl")
    dimensions = {**DIMENSIONS, "rodDiameter": diameter}
    record = {
        "schema": "complete-lamppost-case/v1",
        "source": SOURCE,
        "provenance": "Original parametric tabletop design; not a photograph, scan, print, or user-test result.",
        "dimensionsMm": dimensions,
        "features": FEATURES,
        "repairSpec": REPAIR_SPEC,
        "sourceStlFile": "source.stl",
        "sourceSha256": hashlib.sha256(source_path.read_bytes()).hexdigest(),
        "mesh": {
            "boundsMm": mesh.bounds.tolist(),
            "volumeMm3": float(mesh.volume),
            "watertight": bool(mesh.is_watertight),
            "connectedComponents": 1,
        },
    }
    (output_dir / "case.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    return record


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--diameter-mm", type=float, default=0.5)
    parser.add_argument("--output-dir", required=True, help="new absolute directory inside data/")
    args = parser.parse_args(argv)
    try:
        record = write_case(Path(args.output_dir), args.diameter_mm)
    except (OSError, ValueError) as exc:
        print(str(exc))
        return 1
    print(json.dumps({"outputDir": str(Path(args.output_dir).resolve()), "sourceSha256": record["sourceSha256"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
