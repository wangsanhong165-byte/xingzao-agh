import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from test_measure_plate import make_plate
import cv2


class UnicodeMeasureTest(unittest.TestCase):
    def test_chinese_workspace_path_produces_overlay(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp) / '中文路径'
            folder.mkdir()
            photo = folder / '照片.png'
            ok, encoded = cv2.imencode('.png', make_plate())
            self.assertTrue(ok)
            photo.write_bytes(encoded.tobytes())
            result = subprocess.run([sys.executable, str(ROOT / 'tools/measure_plate.py'), '--image', str(photo), '--width-mm', '80', '--thickness-mm', '6'], capture_output=True, text=True, encoding='utf-8')
            self.assertEqual(result.returncode, 0, result.stdout)
            payload = json.loads(result.stdout)
            self.assertIn('spec', payload)
            self.assertTrue((folder / 'overlay.png').is_file())


if __name__ == '__main__':
    unittest.main()
