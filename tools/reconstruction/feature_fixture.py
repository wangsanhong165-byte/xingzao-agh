"""Create a controlled small-feature part with fixed body and through-hole."""
from __future__ import annotations
import argparse
import math
from pathlib import Path
import trimesh


def create_fixture(pin_diameter: float = .07) -> trimesh.Trimesh:
    if isinstance(pin_diameter, bool) or not isinstance(pin_diameter, (int, float)) or not math.isfinite(pin_diameter) or not .05 <= pin_diameter <= 1:
        raise ValueError('FIXTURE_PIN_DIAMETER_INVALID')
    base = trimesh.creation.box(extents=[20, 18, 3])
    base.apply_translation([0, 0, 1.5])
    pin = trimesh.creation.cylinder(radius=pin_diameter / 2, height=2.1, sections=48)
    pin.apply_translation([5, 0, 3.95])
    hole = trimesh.creation.cylinder(radius=1, height=8, sections=64)
    hole.apply_translation([-4, 0, 1.5])
    body = trimesh.boolean.union([base, pin], engine='manifold')
    mesh = trimesh.boolean.difference([body, hole], engine='manifold')
    if not mesh.is_watertight or not mesh.is_winding_consistent or mesh.volume <= 0:
        raise ValueError('FIXTURE_BOOLEAN_INVALID')
    return mesh


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--pin-diameter', type=float, required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    output = Path(args.output)
    if not output.is_absolute() or output.suffix != '.stl' or not output.resolve().is_relative_to((root / 'data').resolve()):
        raise ValueError('FIXTURE_OUTPUT_PATH_INVALID')
    for parent in [output, *output.parents]:
        if parent.exists() and parent.is_symlink():
            raise ValueError('FIXTURE_OUTPUT_PATH_INVALID')
        if parent == root:
            break
    output.parent.mkdir(parents=True, exist_ok=True)
    create_fixture(args.pin_diameter).export(output, file_type='stl')
