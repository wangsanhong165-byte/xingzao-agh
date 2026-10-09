"""Prepare the fixed private 480x270 character sheet into front/left/back RGBA crops.

This is an experiment helper for the supplied illustrated setting sheet, not a generic
photo matting or multiview detector. It never uploads the source image.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image

from hunyuan_core import USER_SHEET_CROPS, USER_SHEET_SIZE, clean_view_rgba, detect_guide_rows


ROOT = Path(__file__).resolve().parents[2]
OUTPUT_ROOT = ROOT / "data" / "reconstruction" / "generated"
MAX_INPUT_BYTES = 5 * 1024 * 1024
MAX_PIXELS = 12_000_000


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def default_run_id() -> str:
    return "character-sheet-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def prepare(image_path: Path, run_id: str) -> Path:
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", run_id):
        raise ValueError("run_id must contain only lowercase letters, digits, and hyphens")
    payload = image_path.read_bytes()
    if not payload or len(payload) > MAX_INPUT_BYTES:
        raise ValueError("input must be a non-empty image no larger than 5 MiB")
    try:
        from io import BytesIO
        with Image.open(BytesIO(payload)) as source:
            source.verify()
        with Image.open(BytesIO(payload)) as source:
            if source.format not in {"PNG", "JPEG"}:
                raise ValueError("input must be PNG or JPEG")
            if source.width * source.height > MAX_PIXELS:
                raise ValueError("input may not exceed 12 megapixels")
            if source.size != USER_SHEET_SIZE:
                raise ValueError(f"this sheet-prep helper requires {USER_SHEET_SIZE[0]}x{USER_SHEET_SIZE[1]} pixels")
            sheet = source.convert("RGB")
    except ValueError:
        raise
    except Exception as error:
        raise ValueError("input image could not be decoded") from error

    output_dir = OUTPUT_ROOT / run_id
    if output_dir.exists():
        raise FileExistsError(f"output already exists: {output_dir}")
    originals_dir = output_dir / "views-original"
    cleaned_dir = output_dir / "views-cleaned"
    originals_dir.mkdir(parents=True, exist_ok=False)
    cleaned_dir.mkdir(parents=True, exist_ok=False)

    crops = {name: np.asarray(sheet.crop(box)) for name, box in USER_SHEET_CROPS.items()}
    guide_rows = detect_guide_rows(list(crops.values()))
    report = {
        "runId": run_id,
        "sourceImageSha256": sha256(payload),
        "sourceImageBytes": len(payload),
        "sourceImagePixels": list(sheet.size),
        "cropPixels": USER_SHEET_CROPS,
        "viewOrder": ["front", "left", "back"],
        "sideOrientation": "left; the profile face points toward image-left",
        "guideRowsRelativeToCrop": guide_rows,
        "preprocessing": "border-connected neutral removal, cross-view neutral guide-row removal, preserve main and nearby/large components, keep enclosed white components",
        "limitations": [
            "fixed coordinates for the supplied 480x270 illustration sheet only",
            "not a generic segmentation model; gray guides or artwork details may still remain",
            "the image is an illustration sheet, not calibrated orthographic photography",
        ],
        "views": {},
    }
    for name, crop in crops.items():
        original_path = originals_dir / f"{name}.png"
        Image.fromarray(crop, "RGB").save(original_path)
        cleaned, stats = clean_view_rgba(crop, guide_rows)
        cleaned_path = cleaned_dir / f"{name}.png"
        Image.fromarray(cleaned, "RGBA").save(cleaned_path)
        report["views"][name] = {
            **stats,
            "originalCropSha256": sha256(original_path.read_bytes()),
            "cleanedCropSha256": sha256(cleaned_path.read_bytes()),
        }
    report_path = output_dir / "preprocess.json"
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return output_dir


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, required=True, help="private local 480x270 PNG/JPEG sheet")
    parser.add_argument("--run-id", default=default_run_id(), help="safe output folder name under data/reconstruction/generated")
    args = parser.parse_args()
    try:
        output = prepare(args.image, args.run_id)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
