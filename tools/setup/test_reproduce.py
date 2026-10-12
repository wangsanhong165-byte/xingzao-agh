import hashlib
import importlib.util
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('reproduce', Path(__file__).with_name('reproduce.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReproductionBoundaries(unittest.TestCase):
    def test_wrong_asset_never_treated_as_ready(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'asset.bin'
            path.write_bytes(b'changed')
            self.assertFalse(module.file_matches(path, {'size': 7, 'sha256': hashlib.sha256(b'correct').hexdigest()}))
            self.assertFalse(module.file_matches(path, {'size': 7, 'gitBlobId': '0'*40}))

    def test_extract_rejects_escape_without_writing(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = root/'bad.zip'
            with zipfile.ZipFile(archive, 'w') as stream:
                stream.writestr('../escaped.txt', 'bad')
            with self.assertRaises(ValueError):
                module.safe_extract(archive, root/'output')
            self.assertFalse((root/'escaped.txt').exists())

    def test_cannot_reuse_inherited_voice_environment(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            (path/'pyvenv.cfg').write_text('include-system-site-packages = true\n')
            with self.assertRaises(ValueError):
                module.require_isolated_environment(path)

    def test_fresh_shape_config_has_download_source(self):
        specs = module.shape_files()
        config = next(item for item in specs if item['path'].endswith('config.yaml'))
        self.assertEqual(config['gitBlobId'], '7a9b1f3b1ca62e16a24257b8e8328573d299c5e4')
        self.assertEqual(config['revision'], '3a761b539b29fe4ff64714813aa9560fd66f5de0')


if __name__ == '__main__':
    unittest.main()
