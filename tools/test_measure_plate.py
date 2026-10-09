"""Synthetic end-to-end checks for the classical plate-photo measurement CLI."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np


TOOLS = Path(__file__).resolve().parent
SCRIPT = TOOLS / "measure_plate.py"


def make_plate(
    *,
    angle: float = 20,
    background: int = 245,
    foreground: int = 35,
    holes: str = "two-circles",
    crop: bool = False,
    multiple: bool = False,
    long_mm: float = 80,
    short_mm: float = 60,
    pixels_per_mm: int = 5,
) -> np.ndarray:
    """Make a realistic raster top-down plate image with known geometry."""
    scale = pixels_per_mm
    width_px = round(long_mm * scale)
    height_px = round(short_mm * scale)
    canvas = np.full((720, 960, 3), background, dtype=np.uint8)
    cx, cy = 480, 360
    local = np.zeros((height_px, width_px), dtype=np.uint8)
    cv2.rectangle(local, (0, 0), (width_px - 1, height_px - 1), 255, -1)

    hole_positions: list[tuple[float, float]] = []
    if holes == "two-circles":
        hole_positions = [(-20, -10), (20, 10)]
    elif holes == "many-circles":
        hole_positions = [(x_mm, y_mm) for y_mm in (-20, -7, 7, 20) for x_mm in (-30, -15, 0, 15, 30)]
    if hole_positions:
        for x_mm, y_mm in hole_positions:
            point = (round(width_px / 2 + x_mm * scale), round(height_px / 2 + y_mm * scale))
            cv2.circle(local, point, round(3 * scale), 0, -1)
    elif holes == "oval":
        cv2.ellipse(local, (width_px // 2, height_px // 2), (round(8 * scale), round(2 * scale)), 0, 0, 360, 0, -1)
    elif holes not in {"none", "notched-outline", "many-circles"}:
        raise ValueError(holes)

    if holes == "notched-outline":
        cv2.rectangle(local, (0, 0), (round(30 * scale), round(30 * scale)), 0, -1)

    # Place local image on the world canvas, then rotate the complete object.
    x0, y0 = cx - width_px // 2, cy - height_px // 2
    roi = canvas[y0 : y0 + height_px, x0 : x0 + width_px]
    roi[local > 0] = foreground
    if hole_positions:
        # Restore white hole interiors after the dark body was composited.
        for x_mm, y_mm in hole_positions:
            point = (x0 + round(width_px / 2 + x_mm * scale), y0 + round(height_px / 2 + y_mm * scale))
            cv2.circle(canvas, point, round(3 * scale), (background,) * 3, -1)
    elif holes == "oval":
        cv2.ellipse(canvas, (cx, cy), (round(8 * scale), round(2 * scale)), 0, 0, 360, (background,) * 3, -1)

    if holes == "notched-outline":
        cv2.rectangle(canvas, (x0, y0), (x0 + round(30 * scale), y0 + round(30 * scale)), (background,) * 3, -1)

    matrix = cv2.getRotationMatrix2D((cx, cy), angle, 1.0)
    canvas = cv2.warpAffine(canvas, matrix, (canvas.shape[1], canvas.shape[0]), borderValue=(background,) * 3)

    if multiple:
        cv2.rectangle(canvas, (50, 50), (110, 100), (foreground,) * 3, -1)
    if crop:
        # Move enough of the rotated body beyond the frame to make it touch an edge.
        matrix = cv2.getRotationMatrix2D((cx, cy), 0, 1.0)
        matrix[0, 2] += 320
        canvas = cv2.warpAffine(canvas, matrix, (canvas.shape[1], canvas.shape[0]), borderValue=(background,) * 3)
    return canvas


class MeasurePlateTests(unittest.TestCase):
    def invoke(self, image: np.ndarray, *, known_width: float = 80, thickness: float = 4) -> tuple[subprocess.CompletedProcess[str], dict]:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "input.png"
            self.assertTrue(cv2.imwrite(str(path), image))
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--image", str(path), "--width-mm", str(known_width), "--thickness-mm", str(thickness)],
                capture_output=True,
                text=True, encoding="utf-8",
                check=False,
            )
            try:
                payload = json.loads(result.stdout)
            except json.JSONDecodeError as exc:
                self.fail(f"stdout must be one JSON object, got {result.stdout!r}: {exc}")
            if result.returncode == 0:
                self.assertTrue((Path(folder) / "overlay.png").exists())
            return result, payload

    def test_rotated_plate_recovers_outer_size_hole_size_and_local_positions(self) -> None:
        result, payload = self.invoke(make_plate())
        self.assertEqual(result.returncode, 0, payload)
        self.assertEqual(payload["execution"]["mode"], "classical-vision")
        spec = payload["spec"]
        self.assertEqual(spec["type"], "plate")
        self.assertAlmostEqual(spec["dimensions"]["width"], 80, delta=1)
        self.assertAlmostEqual(spec["dimensions"]["depth"], 60, delta=1)
        self.assertEqual(spec["dimensions"]["height"], 4)
        self.assertEqual(spec["dimensions"]["wallThickness"], 3)
        self.assertEqual(len(spec["holes"]), 2)
        actual = sorted(spec["holes"], key=lambda hole: hole["x"])
        self.assertAlmostEqual(actual[0]["x"], -20, delta=1)
        self.assertAlmostEqual(actual[0]["y"], -10, delta=1)
        self.assertAlmostEqual(actual[1]["x"], 20, delta=1)
        self.assertAlmostEqual(actual[1]["y"], 10, delta=1)
        for hole in spec["holes"]:
            self.assertAlmostEqual(hole["diameter"], 6, delta=1)
        warning_text = " ".join(payload["warnings"])
        self.assertIn("人工", warning_text)
        self.assertIn("正俯拍", warning_text)
        self.assertIn("透视", warning_text)
        self.assertIn("overlayPath", payload["measurements"])

    def test_empty_plate_without_holes_is_measurable(self) -> None:
        result, payload = self.invoke(make_plate(holes="none"))
        self.assertEqual(result.returncode, 0, payload)
        self.assertEqual(payload["spec"]["holes"], [])

    def test_non_circular_cutout_is_rejected_instead_of_ignored(self) -> None:
        result, payload = self.invoke(make_plate(holes="oval"))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(payload["code"], "NON_CIRCULAR_HOLE")

    def test_irregular_outer_profile_is_rejected(self) -> None:
        result, payload = self.invoke(make_plate(holes="notched-outline"))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(payload["code"], "NON_RECTANGULAR_OUTLINE")

    def test_multiple_objects_are_rejected_as_ambiguous(self) -> None:
        result, payload = self.invoke(make_plate(multiple=True))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(payload["code"], "MULTIPLE_OBJECTS")

    def test_object_touching_image_edge_is_rejected(self) -> None:
        result, payload = self.invoke(make_plate(crop=True))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(payload["code"], "OBJECT_TOUCHES_EDGE")

    def test_insufficient_foreground_contrast_is_rejected(self) -> None:
        result, payload = self.invoke(make_plate(background=195, foreground=166, holes="none"))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(payload["code"], "LOW_CONTRAST")

    def test_non_positive_or_non_finite_measurement_input_is_rejected_as_json(self) -> None:
        result, payload = self.invoke(make_plate(), known_width=0)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(payload["code"], "INVALID_MEASUREMENT")

    def test_too_many_holes_are_rejected(self) -> None:
        result, payload = self.invoke(make_plate(holes="many-circles", angle=0))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(payload["code"], "TOO_MANY_HOLES")

    def test_small_object_is_rejected(self) -> None:
        result, payload = self.invoke(make_plate(holes="none", pixels_per_mm=0.5))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(payload["code"], "OBJECT_TOO_SMALL")

    def test_decoded_pixel_limit_is_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "input.png"
            image = np.full((4000, 4000, 3), 245, dtype=np.uint8)
            self.assertTrue(cv2.imwrite(str(path), image))
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--image", str(path), "--width-mm", "80", "--thickness-mm", "4"],
                capture_output=True,
                text=True, encoding="utf-8",
                check=False,
            )
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)["code"], "IMAGE_TOO_LARGE")

    def test_encoded_file_limit_is_enforced_before_decode(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "input.png"
            path.write_bytes(b"x" * (5 * 1024 * 1024 + 1))
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--image", str(path), "--width-mm", "80", "--thickness-mm", "4"],
                capture_output=True,
                text=True, encoding="utf-8",
                check=False,
            )
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)["code"], "IMAGE_TOO_LARGE")

    def test_bad_arguments_still_emit_one_json_error(self) -> None:
        result = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True, encoding="utf-8", check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "")
        self.assertEqual(json.loads(result.stdout)["code"], "INVALID_ARGUMENT")

    def test_corrupt_file_has_single_json_error(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "input.png"
            path.write_bytes(b"not an image")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--image", str(path), "--width-mm", "80", "--thickness-mm", "4"],
                capture_output=True,
                text=True, encoding="utf-8",
                check=False,
            )
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)["code"], "DECODE_FAILED")


if __name__ == "__main__":
    unittest.main(verbosity=2)
