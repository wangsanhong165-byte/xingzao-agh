import binascii
import json
import struct
import subprocess
import tempfile
import unittest
import zlib
from pathlib import Path


PYTHON = Path(__file__).resolve().parents[2] / "data" / "reconstruction" / "env-torch-readonly" / "Scripts" / "python.exe"
SCRIPT = Path(__file__).with_name("compare_shape_silhouettes.py")
VIEWS = ("front", "left", "back")


def _png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", binascii.crc32(kind + data) & 0xFFFFFFFF)


def write_rgba_png(path, width, height, pixels):
    rows = b"".join(b"\x00" + bytes(component for pixel in row for component in pixel) for row in pixels)
    payload = b"\x89PNG\r\n\x1a\n"
    payload += _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    payload += _png_chunk(b"IDAT", zlib.compress(rows))
    payload += _png_chunk(b"IEND", b"")
    Path(path).write_bytes(payload)


def rectangle_mask(width, height, rectangles):
    pixels = [[(255, 255, 255, 0) for _ in range(width)] for _ in range(height)]
    for left, top, right, bottom in rectangles:
        for y in range(top, bottom):
            for x in range(left, right):
                pixels[y][x] = (255, 255, 255, 255)
    return pixels


def write_reference(directory, mask):
    Path(directory).mkdir(parents=True, exist_ok=True)
    for view in VIEWS:
        write_rgba_png(Path(directory) / f"{view}.png", len(mask[0]), len(mask), mask)


def write_reference_group(directory, masks):
    Path(directory).mkdir(parents=True, exist_ok=True)
    for view, mask in masks.items():
        write_rgba_png(Path(directory) / f"{view}.png", len(mask[0]), len(mask), mask)


def write_candidate(directory, mask):
    Path(directory).mkdir(parents=True, exist_ok=True)
    height, width = len(mask), len(mask[0])
    pixels = [[(238, 238, 238, 255) for _ in range(width)] for _ in range(height)]
    for y in range(height):
        for x in range(width):
            if mask[y][x][3] > 0:
                pixels[y][x] = (31, 78, 165, 255)
    for view in VIEWS:
        write_rgba_png(Path(directory) / f"{view}.png", width, height, pixels)


def write_candidate_group(directory, masks):
    Path(directory).mkdir(parents=True, exist_ok=True)
    for view, mask in masks.items():
        height, width = len(mask), len(mask[0])
        pixels = [[(238, 238, 238, 255) for _ in range(width)] for _ in range(height)]
        for y in range(height):
            for x in range(width):
                if mask[y][x][3] > 0:
                    pixels[y][x] = (31, 78, 165, 255)
        write_rgba_png(Path(directory) / f"{view}.png", width, height, pixels)


class ShapeSilhouetteCliTests(unittest.TestCase):
    def test_explicit_render_alpha_keeps_dark_cavities_as_geometry(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        reference, candidate, output = root/'reference', root/'candidate', root/'output'
        mask = rectangle_mask(64,64,[(18,12,46,50)])
        write_reference(reference,mask)
        candidate.mkdir()
        # A visible black material patch is still occupied geometry, with no
        # alpha transparency; chroma must not cut a fake opening into it.
        pixels = [[(0,0,0,p[3]) for p in row] for row in mask]
        for view in VIEWS:write_rgba_png(candidate/f'{view}.png',64,64,pixels)
        completed = subprocess.run([str(PYTHON),str(SCRIPT),'--reference-dir',str(reference),'--candidate',f'dark={candidate}','--output-dir',str(output),'--candidate-mask','render-alpha'],capture_output=True,text=True)
        report = self.load_report(completed,output)
        self.assertEqual(report['candidate_silhouette_method'],'render-alpha')
        self.assertTrue(all(v['iou']==1 for v in report['candidates'][0]['views'].values()))

    def test_render_alpha_keeps_real_transparent_opening(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        reference, candidate, output = root/'reference', root/'candidate', root/'output'
        mask = rectangle_mask(64,64,[(18,12,46,50)])
        for y in range(24,36):
            for x in range(25,39):mask[y][x]=(255,255,255,0)
        write_reference(reference,mask);candidate.mkdir()
        for view in VIEWS:write_rgba_png(candidate/f'{view}.png',64,64,mask)
        completed = subprocess.run([str(PYTHON),str(SCRIPT),'--reference-dir',str(reference),'--candidate',f'hole={candidate}','--output-dir',str(output),'--candidate-mask','render-alpha'],capture_output=True,text=True)
        report = self.load_report(completed,output)
        self.assertTrue(all(v['iou']==1 for v in report['candidates'][0]['views'].values()))

    def test_render_alpha_refuses_a_fully_opaque_frame(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        reference, candidate, output = root/'reference', root/'candidate', root/'output'
        mask=rectangle_mask(64,64,[(18,12,46,50)]);write_reference(reference,mask);write_candidate(candidate,mask)
        completed=subprocess.run([str(PYTHON),str(SCRIPT),'--reference-dir',str(reference),'--candidate',f'opaque={candidate}','--output-dir',str(output),'--candidate-mask','render-alpha'],capture_output=True,text=True)
        self.assertNotEqual(completed.returncode,0)
        self.assertIn('transparent background',completed.stderr.lower())

    def run_probe(self, reference_mask, candidate_mask):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        reference_dir = root / "reference"
        candidate_dir = root / "candidate"
        output_dir = root / "new-output"
        write_reference(reference_dir, reference_mask)
        write_candidate(candidate_dir, candidate_mask)
        completed = subprocess.run(
            [str(PYTHON), str(SCRIPT), "--reference-dir", str(reference_dir), "--candidate", f"candidate={candidate_dir}", "--output-dir", str(output_dir)],
            capture_output=True,
            text=True,
            check=False,
        )
        return completed, output_dir

    def load_report(self, completed, output_dir):
        self.assertEqual(completed.returncode, 0, completed.stderr)
        report_path = output_dir / "shape-silhouette-proxy.json"
        self.assertTrue(report_path.is_file())
        report = json.loads(report_path.read_text(encoding="utf-8"))
        self.assertEqual(report["label"], "shape silhouette proxy only")
        self.assertTrue(report["ranking_proxy_only"])
        self.assertTrue(report["review_required"])
        return report

    def test_identical_masks_have_iou_one_and_zero_boundary_error(self):
        mask = rectangle_mask(64, 64, [(21, 18, 43, 46)])
        completed, output_dir = self.run_probe(mask, mask)
        candidate = self.load_report(completed, output_dir)["candidates"][0]
        for view in VIEWS:
            metrics = candidate["views"][view]
            self.assertEqual(metrics["iou"], 1.0)
            self.assertEqual(metrics["boundary_distance_mean_px"], 0.0)
            self.assertEqual(metrics["boundary_distance_p95_px"], 0.0)
            self.assertEqual(metrics["boundary_distance_max_px"], 0.0)
        self.assertTrue((output_dir / "candidate-front-overlay.png").is_file())

    def test_missing_antenna_lowers_iou_and_increases_boundary_error(self):
        reference = rectangle_mask(64, 64, [(25, 25, 39, 48), (30, 8, 34, 25)])
        candidate_mask = rectangle_mask(64, 64, [(25, 25, 39, 48)])
        completed, output_dir = self.run_probe(reference, candidate_mask)
        metrics = self.load_report(completed, output_dir)["candidates"][0]["views"]["front"]
        self.assertLess(metrics["iou"], 1.0)
        self.assertGreater(metrics["boundary_distance_mean_px"], 0.0)

    def test_width_distortion_is_not_removed_by_anisotropic_alignment(self):
        reference = rectangle_mask(64, 64, [(24, 18, 40, 46)])
        wide_candidate = rectangle_mask(64, 64, [(16, 18, 48, 46)])
        completed, output_dir = self.run_probe(reference, wide_candidate)
        metrics = self.load_report(completed, output_dir)["candidates"][0]["views"]["front"]
        self.assertLess(metrics["iou"], 0.8)
        self.assertGreater(metrics["boundary_distance_mean_px"], 0.0)

    def test_group_scale_preserves_relative_view_heights(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        reference_dir, candidate_dir, output_dir = root / "reference", root / "candidate", root / "new-output"
        ref = {
            "front": rectangle_mask(64, 64, [(24, 20, 40, 40)]),
            "left": rectangle_mask(64, 64, [(24, 20, 40, 40)]),
            "back": rectangle_mask(64, 64, [(24, 12, 40, 52)]),
        }
        candidate = {
            "front": rectangle_mask(64, 64, [(24, 12, 40, 52)]),
            "left": rectangle_mask(64, 64, [(24, 20, 40, 40)]),
            "back": rectangle_mask(64, 64, [(24, 12, 40, 52)]),
        }
        write_reference_group(reference_dir, ref)
        write_candidate_group(candidate_dir, candidate)
        completed = subprocess.run(
            [str(PYTHON), str(SCRIPT), "--reference-dir", str(reference_dir), "--candidate", f"candidate={candidate_dir}", "--output-dir", str(output_dir)],
            capture_output=True,
            text=True,
            check=False,
        )
        report = self.load_report(completed, output_dir)["candidates"][0]
        self.assertLess(report["views"]["front"]["iou"], 0.8)
        self.assertEqual(report["views"]["back"]["iou"], 1.0)

    def test_ultrawide_model_expands_canvas_instead_of_cropping(self):
        mask = rectangle_mask(256, 64, [(8, 24, 248, 40)])
        completed, output_dir = self.run_probe(mask, mask)
        report = self.load_report(completed, output_dir)
        self.assertGreater(report["canvas"]["width"], 1024)
        self.assertGreaterEqual(report["canvas"]["height"], 512)

    def test_empty_reference_silhouette_is_rejected(self):
        empty = rectangle_mask(64, 64, [])
        candidate = rectangle_mask(64, 64, [(20, 18, 44, 46)])
        completed, _ = self.run_probe(empty, candidate)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("empty silhouette", completed.stderr.lower())

    def test_candidate_without_blue_chroma_silhouette_is_rejected(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        mask = rectangle_mask(64, 64, [(20, 18, 44, 46)])
        reference_dir, candidate_dir, output_dir = root / "reference", root / "candidate", root / "out"
        write_reference(reference_dir, mask)
        candidate_dir.mkdir()
        neutral = [[(230, 230, 230, 255) for _ in range(64)] for _ in range(64)]
        for view in VIEWS:
            write_rgba_png(candidate_dir / f"{view}.png", 64, 64, neutral)
        completed = subprocess.run(
            [str(PYTHON), str(SCRIPT), "--reference-dir", str(reference_dir), "--candidate", f"candidate={candidate_dir}", "--output-dir", str(output_dir)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("blue silhouette", completed.stderr.lower())

    def test_existing_output_directory_is_never_overwritten(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        reference_dir, candidate_dir, output_dir = root / "reference", root / "candidate", root / "existing-output"
        mask = rectangle_mask(64, 64, [(20, 18, 44, 46)])
        write_reference(reference_dir, mask)
        write_candidate(candidate_dir, mask)
        output_dir.mkdir()
        sentinel = output_dir / "keep.txt"
        sentinel.write_text("existing output remains unchanged", encoding="utf-8")
        completed = subprocess.run(
            [str(PYTHON), str(SCRIPT), "--reference-dir", str(reference_dir), "--candidate", f"candidate={candidate_dir}", "--output-dir", str(output_dir)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("already exists", completed.stderr.lower())
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "existing output remains unchanged")


if __name__ == "__main__":
    unittest.main()
