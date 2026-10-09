"""Verify executable source against an author-derived Git blob manifest."""
import hashlib
import re
from pathlib import Path, PurePosixPath

SOURCE_EXTENSIONS = frozenset(('.py', '.cu', '.cuh', '.cpp', '.h', '.hpp'))
GIT_ID = re.compile(r'^[0-9a-f]{40}$')
PINNED_SOURCE_REVISION = 'f8db63096c8282cb27354314d896feba5ba6ff8a'
PINNED_SOURCE_TREE = 'aa9c5e5d318d2ea2825de6c3ca76d6438f661322'


def verify_texture_source(source_root, manifest):
    """Reject changed, missing, extra, escaped or symlinked executable files.

    Manifest provenance is the author's pinned Git commit/tree. Only source
    under hy3dgen is covered; this is not a verification of installed Torch or
    compiled extensions, whose builds are recorded separately.
    """
    root = Path(source_root).resolve(strict=True)
    if not isinstance(manifest, dict) or manifest.get('repo') != 'Tencent-Hunyuan/Hunyuan3D-2':
        raise ValueError('unsupported source manifest')
    for field in ('revision', 'gitTree'):
        if not isinstance(manifest.get(field), str) or not GIT_ID.fullmatch(manifest[field]):
            raise ValueError(f'invalid source {field}')
    if (manifest['revision'] != PINNED_SOURCE_REVISION
            or manifest['gitTree'] != PINNED_SOURCE_TREE):
        raise ValueError('source revision/tree differs from expected pinned version')
    entries = manifest.get('files')
    if not isinstance(entries, list) or not entries:
        raise ValueError('source manifest requires files')
    expected = {}
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get('path'), str):
            raise ValueError('invalid source file entry')
        name = entry['path']
        path = PurePosixPath(name)
        if (path.is_absolute() or '\\' in name or '..' in path.parts
                or path.as_posix() != name or len(path.parts) < 2
                or path.parts[0] != 'hy3dgen' or path.suffix not in SOURCE_EXTENSIONS):
            raise ValueError('source manifest path must stay under hy3dgen')
        if name in expected:
            raise ValueError('duplicate source manifest path')
        size = entry.get('size')
        blob = entry.get('gitBlobId')
        if (isinstance(size, bool) or not isinstance(size, int) or size < 0
                or not isinstance(blob, str) or not GIT_ID.fullmatch(blob)):
            raise ValueError('invalid source blob metadata')
        expected[name] = entry
    actual = {
        path.relative_to(root).as_posix(): path
        for path in (root/'hy3dgen').rglob('*')
        if path.is_file() and path.suffix in SOURCE_EXTENSIONS
    }
    if set(actual) != set(expected):
        raise ValueError('executable source file set differs from pinned tree')
    for name, path in actual.items():
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            raise ValueError('source path is symlinked or escaped')
        entry = expected[name]
        if path.stat().st_size != entry['size']:
            raise ValueError(f'source blob size mismatch: {name}')
        contents = path.read_bytes()
        blob = hashlib.sha1(b'blob '+str(len(contents)).encode('ascii')+b'\0'+contents).hexdigest()
        if blob != entry['gitBlobId']:
            raise ValueError(f'source blob mismatch: {name}')
    return {
        'repo': manifest['repo'], 'revision': manifest['revision'],
        'gitTree': manifest['gitTree'], 'verifiedFiles': len(expected),
        'scope': 'all hy3dgen Python/native source; installed dependencies and binary extensions excluded',
    }
