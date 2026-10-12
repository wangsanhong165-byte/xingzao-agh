import hashlib
import importlib.util
import tempfile
import unittest
import zipfile
import json
from unittest.mock import patch
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

    def test_verified_cli_kit_works_without_network(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            (root/'data/setup').mkdir(parents=True)
            (root/'tools/setup').mkdir(parents=True)
            archive=root/'data/setup/PrusaSlicer-cli-2.9.6.zip'
            with zipfile.ZipFile(archive,'w') as z:
                z.writestr('PrusaSlicer-2.9.6/prusa-slicer-console.exe',b'fixture-exe')
            (root/'tools/setup/slicer-cli-manifest.json').write_text(json.dumps({'sha256':hashlib.sha256(archive.read_bytes()).hexdigest()}))
            with patch.object(module,'ROOT',root),patch.object(module,'download_archive',side_effect=AssertionError('Unexpected network download')),patch.object(module,'invoke'):
                module.prepare_slicer()
            self.assertEqual((root/'data/tools/prusaslicer-2.9.6/PrusaSlicer-2.9.6/prusa-slicer-console.exe').read_bytes(),b'fixture-exe')


if __name__ == '__main__':
    unittest.main()
