import base64
import unittest

import cv2
import numpy as np

from tools.extract_detail import extract_detail


def encode(image):
    ok, data = cv2.imencode('.png', image)
    assert ok
    return data.tobytes()


class DetailExtractionTests(unittest.TestCase):
    def test_preserves_closed_glyph_hole_and_returns_masks_and_contours(self):
        image = np.full((100, 120, 3), 255, dtype=np.uint8)
        cv2.ellipse(image, (60, 50), (28, 36), 0, 0, 360, (10, 20, 30), -1)
        cv2.ellipse(image, (60, 50), (15, 24), 0, 0, 360, (255, 255, 255), -1)
        result = extract_detail(encode(image), 40, 30, 1.0, (0, 0, 120, 100), 0.65)
        target = cv2.imdecode(np.frombuffer(base64.b64decode(result['targetMask']['dataBase64']), np.uint8), cv2.IMREAD_GRAYSCALE)
        enhanced = cv2.imdecode(np.frombuffer(base64.b64decode(result['enhancedMask']['dataBase64']), np.uint8), cv2.IMREAD_GRAYSCALE)
        self.assertEqual(target.shape, (100, 120))
        self.assertEqual(enhanced.shape, target.shape)
        self.assertGreaterEqual(sum(len(item['holes']) for item in result['contours']), 1)
        self.assertEqual(result['topologyPreserved'], True)
        self.assertGreaterEqual(result['fidelity'], 0.65)

    def test_rejects_roi_outside_image(self):
        image = np.full((30, 40, 3), 255, dtype=np.uint8)
        with self.assertRaisesRegex(ValueError, 'ROI|roi|范围'):
            extract_detail(encode(image), 40, 30, 0.8, (20, 0, 30, 30), 0.5)

    def test_reports_feature_loss_when_minimum_width_erases_small_hole(self):
        image = np.full((100, 100, 3), 255, dtype=np.uint8)
        cv2.rectangle(image, (25, 15), (75, 85), (0, 0, 0), -1)
        cv2.rectangle(image, (43, 40), (57, 60), (255, 255, 255), -1)
        result = extract_detail(encode(image), 20, 20, 3.0, (0, 0, 100, 100), 0.95)
        self.assertFalse(result['topologyPreserved'])
        self.assertLess(result['fidelity'], 0.95)
        self.assertTrue(any('孔' in warning or '合并' in warning or '保真' in warning for warning in result['warnings']))

    def test_small_roi_keeps_full_image_physical_scale_and_position(self):
        image = np.full((160, 240, 3), 255, dtype=np.uint8)
        cv2.rectangle(image, (92, 52), (108, 76), (0, 0, 0), -1)
        result = extract_detail(encode(image), 40, 30, 0.4, (72, 40, 80, 64), 0.75)

        target = cv2.imdecode(np.frombuffer(base64.b64decode(result['targetMask']['dataBase64']), np.uint8), cv2.IMREAD_GRAYSCALE)
        enhanced = cv2.imdecode(np.frombuffer(base64.b64decode(result['enhancedMask']['dataBase64']), np.uint8), cv2.IMREAD_GRAYSCALE)
        self.assertEqual(target.shape, (160, 240))
        self.assertEqual(enhanced.shape, (160, 240))
        self.assertEqual(result['sourceRoiSize'], [80, 64])
        self.assertTrue(result['minWidthIsTarget'])
        self.assertIn('目标最小特征宽度', result['minWidthMeaning'])
        self.assertIn('精确测量或保证', result['minWidthMeaning'])
        x_min, y_min, x_max, y_max = result['featureBoundsMm']
        # Full-image scaling puts this 16 px mark around x=-3.3 mm and y=+3 mm.
        # A crop-to-board zoom would instead move it toward ROI-local coordinates
        # and inflate its physical width several times.
        self.assertAlmostEqual((x_min + x_max) / 2, -3.33, delta=0.45)
        self.assertAlmostEqual((y_min + y_max) / 2, 3.0, delta=0.45)
        self.assertLess(x_max - x_min, 5.0)
        full_roi = extract_detail(encode(image), 40, 30, 0.4, (0, 0, 240, 160), 0.75)
        np.testing.assert_allclose(result['featureBoundsMm'], full_roi['featureBoundsMm'], atol=0.01)

    def test_roi_edge_clamps_enhancement_and_reports_width_limitation(self):
        image = np.full((120, 160, 3), 255, dtype=np.uint8)
        cv2.rectangle(image, (40, 40), (55, 70), (0, 0, 0), -1)
        roi = (40, 30, 30, 50)
        result = extract_detail(encode(image), 40, 30, 1.0, roi, 0.4)
        enhanced = cv2.imdecode(np.frombuffer(base64.b64decode(result['enhancedMask']['dataBase64']), np.uint8), cv2.IMREAD_GRAYSCALE)
        rx, ry, rw, rh = roi
        outside = enhanced.copy()
        outside[ry:ry + rh, rx:rx + rw] = 0
        self.assertEqual(int(np.count_nonzero(outside)), 0)
        self.assertTrue(any('ROI边缘' in warning for warning in result['warnings']))


if __name__ == '__main__':
    unittest.main()
