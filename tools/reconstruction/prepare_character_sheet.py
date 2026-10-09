"""Crop and clean the private 480x270 illustrated setting sheet used in this experiment."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image

from hunyuan_core import USER_SHEET_CROPS, USER_SHEET_SIZE, clean_view_rgba, detect_guide_rows


ROOT = Path(__file__).resolve().parents[2]
OUTPUT_ROOT = ROOT / "data" / "reconstruction" / "generated"
MAX_INPUT_BYTES = 5 * 1024 * 1024
MAX_PIXELS = 12_000_000


def prepare_sheet(image_path: Path, run_id: str) -> Path:
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", run_id):
        raise ValueError("run_id must contain only lowercase letters, digits, and hyphens")
    payload = image_path.read_bytes()
    if not payload or len(payload) > MAX_INPUT_BYTES:
        raise ValueError("source image must be non-empty and no larger than 5 MiB")
    try:
        with Image.open(BytesIO(payload)) as source:
            source.verify()
        with Image.open(BytesIO(payload)) as source:
            if source.format not in {"PNG", "JPEG"}:
                raise ValueError("source image must be PNG or JPEG")
            if source.width * source.height > MAX_PIXELS:
                raise ValueError("source image may not exceed 12 megapixels")
            if source.size != USER_SHEET_SIZE:
                raise ValueError(f"this one-off sheet prep requires {USER_SHEET_SIZE[0]}x{USER_SHEET_SIZE[1]} pixels")
            sheet = source.convert("RGB")
    except ValueError:
        raise
    except Exception as error:
        raise ValueError("source image could not be decoded") from error

    output_dir = OUTPUT_ROOT / run_id
    if output_dir.exists():
        raise FileExistsError(f"output already exists: {output_dir}")
    original_dir = output_dir / "views-original"
    cleaned_dir = output_dir / "views-cleaned"
    original_dir.mkdir(parents=True, exist_ok=False)
    cleaned_dir.mkdir(parents=True, exist_ok=False)

    crops = {name: np.asarray(sheet.crop(rect)) for name, rect in USER_SHEET_CROPS.items()}
    guide_rows = detect_guide_rows(list(crops.values()))
    report = {
        "runId": run_id,
        "sourceSha256": hashlib.sha256(payload).hexdigest(),
        "sourceBytes": len(payload),
        "sourcePixels": list(sheet.size),
        "cropsPx": USER_SHEET_CROPS,
        "viewOrder": ["front", "left", "back"],
        "sideOrientation": "left; profile face points toward image-left",
        "guideRowsRelativeToCrop": guide_rows,
        "maskMethod": "pale border-connected components transparent; detected cross-view neutral guide pixels transparent; keep largest body and nearby/large components; preserve enclosed white areas",
        "limitations": [
            "fixed crops for this 480x270 illustration setting sheet only",
            "not a generic photo segmentation service",
            "hairline guides or antialiasing can remain; inspect saved views before inference",
            "the source is an illustration, not calibrated orthographic photography",
        ],
        "views": {},
    }
    for name, rgb in crops.items():
        before = original_dir / f"{name}.png"
        after = cleaned_dir / f"{name}.png"
        Image.fromarray(rgb, "RGB").save(before, format="PNG")
        cleaned, stats = clean_view_rgba(rgb, guide_rows)
        Image.fromarray(cleaned, "RGBA").save(after, format="PNG")
        report["views"][name] = {
            **stats,
            "originalCropSha256": hashlib.sha256(before.read_bytes()).hexdigest(),
            "cleanedCropSha256": hashlib.sha256(after.read_bytes()).hexdigest(),
        }
    (output_dir / "preprocess.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return output_dir


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, required=True, help="private local 480x270 setting sheet")
    parser.add_argument("--run-id", default="character-sheet-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S"))
    args = parser.parse_args()
    try:
        output = prepare_sheet(args.image, args.run_id)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
