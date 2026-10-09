"""Source claims must fail closed when executable files drift."""
import hashlib
import tempfile
import unittest
from pathlib import Path

from texture_source_pins import verify_texture_source


class SourcePinTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.path=self.root/'hy3dgen/texgen/pipelines.py'
        self.path.parent.mkdir(parents=True)
        self.contents=b'PINNED = 1\n'
        self.path.write_bytes(self.contents)
        blob=hashlib.sha1(b'blob '+str(len(self.contents)).encode()+b'\0'+self.contents).hexdigest()
        self.manifest={'repo':'Tencent-Hunyuan/Hunyuan3D-2','revision':'f8db63096c8282cb27354314d896feba5ba6ff8a','gitTree':'aa9c5e5d318d2ea2825de6c3ca76d6438f661322','files':[{'path':'hy3dgen/texgen/pipelines.py','size':len(self.contents),'gitBlobId':blob}]}

    def test_author_bytes_return_verified_revision(self):
        result=verify_texture_source(self.root,self.manifest)
        self.assertEqual(result['revision'],self.manifest['revision'])
        self.assertEqual(result['verifiedFiles'],1)

    def test_equal_length_mutated_code_is_rejected(self):
        self.path.write_bytes(b'PINNED = 2\n')
        with self.assertRaisesRegex(ValueError,'blob'):
            verify_texture_source(self.root,self.manifest)

    def test_added_or_missing_executable_source_is_rejected(self):
        extra=self.path.with_name('unexpected.py');extra.write_text('pass\n')
        with self.assertRaisesRegex(ValueError,'file set'):
            verify_texture_source(self.root,self.manifest)
        extra.unlink();self.path.unlink()
        with self.assertRaisesRegex(ValueError,'file set'):
            verify_texture_source(self.root,self.manifest)

    def test_escape_duplicate_and_malformed_manifest_are_rejected(self):
        for invalid in ['../outside.py','/hy3dgen/p.py','hy3dgen/../p.py','hy3dgen\\p.py']:
            manifest={**self.manifest,'files':[{**self.manifest['files'][0],'path':invalid}]}
            with self.assertRaises(ValueError):verify_texture_source(self.root,manifest)
        with self.assertRaises(ValueError):
            verify_texture_source(self.root,{**self.manifest,'files':self.manifest['files']*2})
        with self.assertRaises(ValueError):
            verify_texture_source(self.root,{**self.manifest,'revision':'unknown'})

    def test_valid_but_unexpected_revision_and_tree_are_rejected(self):
        for field in ('revision','gitTree'):
            with self.subTest(field=field):
                with self.assertRaisesRegex(ValueError,'pinned version'):
                    verify_texture_source(self.root,{**self.manifest,field:'e'*40})


if __name__=='__main__':unittest.main()
