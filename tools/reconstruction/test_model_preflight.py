import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import download_shape as downloader
import generate_hunyuan_multiview as generator


class ModelPreflightTests(unittest.TestCase):
    def test_preflight_accepts_the_verified_downloaders_actual_directory_layout(self):
        area = generator.ROOT / 'data' / 'reconstruction' / 'preflight-tests'
        area.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=area) as directory:
            base = Path(directory).resolve()
            self.assertTrue(base.is_relative_to(area.resolve()))
            cache = base / 'modelcache'
            repo = cache / 'hunyuan3d-2mv'
            source = base / 'source'
            (source / 'hy3dgen' / 'shapegen').mkdir(parents=True)
            (source / 'hy3dgen' / 'shapegen' / 'pipelines.py').write_text('# test fixture')
            weight = repo / generator.MODEL_SUBFOLDER / 'model.fp16.safetensors'
            weight.parent.mkdir(parents=True)
            content = b'preflight-only fixture; not loadable neural weights'
            weight.write_bytes(content)
            config = weight.parent / 'config.yaml'
            config_bytes = b'model: test-fixture\n'
            config.write_bytes(config_bytes)
            digest = hashlib.sha256(content).hexdigest()
            actual_manifest = cache / downloader.MANIFEST_PATH.relative_to(downloader.CACHE_ROOT.parent)
            actual_manifest.write_text(json.dumps({'repo': generator.MODEL_REPO, 'revision': generator.MODEL_REVISION, 'path': f'{generator.MODEL_SUBFOLDER}/model.fp16.safetensors', 'size': len(content), 'sha256': digest}))
            consumer_manifest = cache / generator.MANIFEST_PATH.relative_to(generator.MODEL_CACHE_ROOT)
            with patch.multiple(generator, SOURCE_ROOT=source, WEIGHT_PATH=weight, CONFIG_PATH=config, MANIFEST_PATH=consumer_manifest, MODEL_SIZE=len(content), MODEL_SHA256=digest, CONFIG_GIT_BLOB_SHA1=generator._git_blob_sha1(config_bytes)):
                result = generator.verify_local_model()
                self.assertEqual(result['weightsSha256'], digest)
                weight.write_bytes(b'changed' + content)
                with self.assertRaisesRegex(ValueError, 'SHA-256'):
                    generator.verify_local_model()


if __name__ == '__main__':
    unittest.main()
