import unittest

import numpy as np

from hunyuan_core import (
    clean_view_rgba,
    compute_yup_to_zup_transform,
    detect_guide_rows,
    requires_import_simplification,
    validate_run_options,
)


class HunyuanCoreTests(unittest.TestCase):
    def test_import_simplification_gate_uses_triangle_and_byte_limits(self):
        self.assertFalse(requires_import_simplification(250_000, 25 * 1024 * 1024))
        self.assertTrue(requires_import_simplification(250_001, 100))
        self.assertTrue(requires_import_simplification(1, 25 * 1024 * 1024 + 1))

    def test_run_options_are_bounded_and_return_normalized_values(self):
        options = validate_run_options(
            steps=25,
            resolution=256,
            num_chunks=8000,
            seed=12345,
            target_longest_edge_mm=100,
            run_id="character-test",
        )
        self.assertEqual(options["numInferenceSteps"], 25)
        self.assertEqual(options["octreeResolution"], 256)
        self.assertEqual(options["numChunks"], 8000)
        for values in (
            {"steps": 4},
            {"steps": 51},
            {"resolution": 192},
            {"num_chunks": 999},
            {"seed": -1},
            {"target_longest_edge_mm": 0},
            {"run_id": "../outside"},
        ):
            args = {"steps": 25, "resolution": 128, "num_chunks": 8000, "seed": 1,
                    "target_longest_edge_mm": 100, "run_id": "sample"}
            args.update(values)
            with self.subTest(values=values), self.assertRaises(ValueError):
                validate_run_options(**args)

    def test_y_up_transform_maps_height_to_z_and_centers_bottom(self):
        vertices = np.array(
            [[-1, -2, -1], [1, 2, 1], [-0.5, 1, 0.25]], dtype=np.float64
        )
        matrix, metadata = compute_yup_to_zup_transform(vertices, 100)
        transformed = np.concatenate((vertices, np.ones((len(vertices), 1))), axis=1) @ matrix.T
        extents = transformed[:, :3].max(axis=0) - transformed[:, :3].min(axis=0)
        self.assertAlmostEqual(float(extents[2]), 100.0, places=6)
        self.assertAlmostEqual(float(transformed[:, 0].min() + transformed[:, 0].max()), 0.0, places=6)
        self.assertAlmostEqual(float(transformed[:, 1].min() + transformed[:, 1].max()), 0.0, places=6)
        self.assertAlmostEqual(float(transformed[:, 2].min()), 0.0, places=6)
        self.assertEqual(metadata["sourceUpAxis"], "Y")

    def test_bounded_384_resolution_is_available_for_a_controlled_geometry_experiment(self):
        args = {"steps": 25, "resolution": 384, "num_chunks": 8000, "seed": 12345,
                "target_longest_edge_mm": 100, "run_id": "hair-res384-reference"}
        self.assertEqual(validate_run_options(**args)["octreeResolution"], 384)
        for value in (512, 384.0, True):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_run_options(**{**args, "resolution": value})

    def test_guide_row_detection_uses_shared_neutral_rows(self):
        views = []
        for _ in range(3):
            image = np.full((32, 40, 3), 246, dtype=np.uint8)
            image[7, :, :] = (220, 220, 220)
            image[20, :, :] = (218, 219, 220)
            views.append(image)
        self.assertEqual(detect_guide_rows(views, minimum_shared_pixels=65), [7, 20])
        with self.assertRaises(ValueError):
            detect_guide_rows([views[0], np.zeros((31, 40, 3), dtype=np.uint8)])
        with self.assertRaises(ValueError):
            detect_guide_rows([views[0], np.zeros((32, 40), dtype=np.uint8)])

    def test_cleanup_removes_background_guides_and_far_annotation_but_keeps_white_cloth_and_tuft(self):
        rgb = np.full((64, 64, 3), 246, dtype=np.uint8)
        rgb[5, :, :] = (220, 220, 220)  # neutral guide line connected across the background
        rgb[12:52, 12:44, :] = (24, 30, 70)  # main dark character region
        rgb[20:32, 20:32, :] = (250, 250, 250)  # enclosed white clothing must remain foreground
        rgb[8:12, 27:31, :] = (45, 80, 160)  # connected hair tuft
        rgb[57:59, 57:59, :] = (20, 20, 20)  # detached annotation speck
        rgba, report = clean_view_rgba(rgb, guide_rows=[5])
        self.assertEqual(int(rgba[5, 5, 3]), 0)
        self.assertEqual(int(rgba[25, 25, 3]), 255)
        self.assertEqual(int(rgba[9, 29, 3]), 255)
        self.assertEqual(int(rgba[57, 57, 3]), 0)
        self.assertGreater(report["removedComponents"], 0)


if __name__ == "__main__":
    unittest.main()
