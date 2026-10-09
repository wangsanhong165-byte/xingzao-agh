"""Decode and bound the three reconstruction inputs using Pillow."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image


def inspect(paths: dict[str, Path]) -> dict:
    result = {}
    for name, path in paths.items():
        with Image.open(path) as image:
            if image.format not in {"PNG", "JPEG"}:
                raise ValueError("unsupported image format")
            if image.width < 1 or image.height < 1 or image.width * image.height > 12_000_000:
                raise ValueError("image dimensions out of bounds")
            image.verify()
        with Image.open(path) as image:
            image.load()
            result[name] = {"format": image.format, "width": image.width, "height": image.height}
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    for name in ("front", "left", "back"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(inspect({name: getattr(args, name) for name in ("front", "left", "back")})))


if __name__ == "__main__":
    main()
