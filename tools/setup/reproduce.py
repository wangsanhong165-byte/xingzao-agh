"""Prepare this project's isolated dependencies and pinned public assets.

Run with a normal Python 3.12 installation. No API key is read or copied.
Downloads and environments remain below data/. Existing inherited environments
are rejected, never changed. Use --plan to inspect a command without installing.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tempfile
from urllib.request import urlopen
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SETUP = Path(__file__).resolve().parent
SOURCE_REV = 'f8db63096c8282cb27354314d896feba5ba6ff8a'
SOURCE_DIR = Path('data/reconstruction/source-f8db630')/('Hunyuan3D-2-'+SOURCE_REV)
SOURCE_ZIP_SHA = '1be140879646034a98941e494072ce0ab26918fdc2fb59210443d56d41bc5622'
SLICER_URL = 'https://github.com/prusa3d/PrusaSlicer/releases/download/version_2.9.6/PrusaSlicer-2.9.6.zip'
SLICER_SHA = '5aaf22e42f95accecfa122d23a835911f289ecc2ff606db3e83d637ddcc0a209'


def node_runtime(root=None):
    bundled = Path(root or ROOT)/'data/tools/node-v24.16.0-win-x64/node.exe'
    if bundled.is_file():
        return str(bundled)
    selected = shutil.which('node.exe') or shutil.which('node')
    if not selected:
        raise RuntimeError('Node.js 24.10+ is required; install Node or use the bundled runtime')
    return selected


def file_matches(path, item):
    path = Path(path)
    if not path.is_file() or path.is_symlink() or path.stat().st_size != item['size']:
        return False
    if item.get('sha256'):
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for block in iter(lambda: stream.read(8*1024*1024), b''):
                digest.update(block)
        return digest.hexdigest() == item['sha256'].lower()
    payload = path.read_bytes()
    return hashlib.sha1(b'blob '+str(len(payload)).encode()+b'\0'+payload).hexdigest() == item['gitBlobId']


def safe_extract(archive, destination):
    destination = Path(destination).resolve()
    with zipfile.ZipFile(archive) as stream:
        for item in stream.infolist():
            name = PurePosixPath(item.filename)
            if (name.is_absolute() or '..' in name.parts or '\\' in item.filename
                    or ':' in item.filename or (item.external_attr >> 16) & 0o170000 == 0o120000):
                raise ValueError('Unsafe archive path: '+item.filename)
            if not (destination/item.filename).resolve().is_relative_to(destination):
                raise ValueError('Archive path escapes destination')
        stream.extractall(destination)


def require_isolated_environment(path):
    config = Path(path)/'pyvenv.cfg'
    if not config.exists():
        raise ValueError('Existing directory is not an isolated venv: '+str(path))
    contents = config.read_text('utf-8').lower()
    if 'include-system-site-packages = false' not in contents:
        raise ValueError('Inherited environment will not be modified; use a fresh source directory: '+str(path))


def shape_files():
    repo = 'tencent/Hunyuan3D-2mv'
    revision = '3a761b539b29fe4ff64714813aa9560fd66f5de0'
    return [
        dict(repo=repo, revision=revision, path='hunyuan3d-dit-v2-mv/config.yaml', size=1608,
             gitBlobId='7a9b1f3b1ca62e16a24257b8e8328573d299c5e4'),
        dict(repo=repo, revision=revision, path='hunyuan3d-dit-v2-mv/model.fp16.safetensors',
             size=4928151562, sha256='d36f5881bcdc56726b73e517cd444c13c60732431622da7268145355c8d38e9c'),
    ]


def invoke(arguments, plan=False, cwd=None):
    print('> '+subprocess.list2cmdline([str(arg) for arg in arguments]), flush=True)
    if not plan:
        subprocess.run([str(arg) for arg in arguments], cwd=cwd or ROOT, check=True)


def prepare_environment(kind, wheelhouse=None, plan=False):
    if sys.platform != 'win32' or sys.version_info[:2] != (3, 12) or sys.maxsize <= 2**32:
        raise ValueError('Use Windows x64 and 64-bit Python 3.12 for these pinned dependencies')
    if kind not in ('cpu', 'cpu-review', 'gpu'):
        raise ValueError('Unknown environment kind')
    if kind == 'cpu-review' and wheelhouse is None:
        packaged = ROOT/'data/setup/wheels'
        if packaged.is_dir():
            wheelhouse = packaged
    environments = ['env-torch-readonly'] + (['env-texture-probe'] if kind == 'gpu' else [])
    for name in environments:
        directory = ROOT/'data/reconstruction'/name
        if directory.exists():
            require_isolated_environment(directory)
        else:
            invoke([sys.executable, '-m', 'venv', directory], plan)
        executable = directory/'Scripts/python.exe'
        pip = [executable, '-m', 'pip', 'install', '--disable-pip-version-check']
        offline = ['--no-index', '--find-links', Path(wheelhouse).resolve()] if wheelhouse else []
        if wheelhouse:
            invoke(pip+offline+['setuptools==81.0.0', 'wheel==0.46.3'], plan)
        if kind == 'gpu':
            torch_wheel = ROOT/'data/setup/wheels/torch-2.11.0+cu130-cp312-cp312-win_amd64.whl'
            if not wheelhouse and torch_wheel.exists():
                if not file_matches(torch_wheel, {'size': 1915224818,
                        'sha256': 'ef8beae16d781c3244ef28dc7bee6d8871c26bbde65d5bf66e902cb61972c4ab'}):
                    raise ValueError('Local Torch wheel differs from official hash')
                invoke(pip+['--no-deps', torch_wheel], plan)
            invoke(pip+offline+([] if offline else ['--index-url', 'https://download.pytorch.org/whl/cu130'])
                   +['-c', SETUP/'constraints-runtime.txt', '-r', SETUP/'requirements-torch.txt'], plan)
        invoke(pip+offline+(['--no-build-isolation'] if offline else [])
               +['-c', SETUP/'constraints-runtime.txt', '-r', SETUP/f'requirements-{kind}.txt'], plan)
        invoke([executable, '-m', 'pip', 'check'], plan)


def prepare_wheels(kind, destination, plan=False):
    if sys.platform != 'win32' or sys.version_info[:2] != (3, 12) or sys.maxsize <= 2**32:
        raise ValueError('Wheelhouse creation targets Windows x64 and 64-bit Python 3.12')
    destination = Path(destination).resolve()
    if not plan:
        destination.mkdir(parents=True, exist_ok=True)
    base = [sys.executable, '-m', 'pip', 'download', '--dest', destination]
    if kind == 'gpu':
        invoke(base+['--index-url', 'https://download.pytorch.org/whl/cu130', '-c', SETUP/'constraints-runtime.txt',
                     '-r', SETUP/'requirements-torch.txt'], plan)
    # OmegaConf's antlr4 runtime is a small pure Python source distribution.
    # pip install can build it offline using the setuptools/wheel downloaded here.
    invoke(base+(['--extra-index-url', 'https://download.pytorch.org/whl/cu130'] if kind == 'gpu' else [])
           +['-c', SETUP/'constraints-runtime.txt', '-r', SETUP/f'requirements-{kind}.txt',
             'setuptools==81.0.0', 'wheel==0.46.3'], plan)


def download_archive(url, target, expected_hash, plan=False):
    if target.is_file():
        actual = hashlib.sha256(target.read_bytes()).hexdigest()
        if actual == expected_hash:
            return
        raise ValueError('Existing archive differs from pinned hash: '+str(target))
    print('Download: '+url, flush=True)
    if plan:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix+'.part')
    with urlopen(url, timeout=60) as response, temporary.open('wb') as output:
        shutil.copyfileobj(response, output, 1024*1024)
    if hashlib.sha256(temporary.read_bytes()).hexdigest() != expected_hash:
        raise ValueError('Downloaded archive hash mismatch; final path was not installed')
    os.replace(temporary, target)


def prepare_source(plan=False):
    sys.path.insert(0, str(ROOT/'tools/reconstruction'))
    from texture_source_pins import verify_texture_source
    manifest = json.loads((ROOT/'tools/reconstruction/texture_source_manifest.json').read_text('utf-8'))
    source = ROOT/SOURCE_DIR
    if source.exists():
        print(json.dumps(verify_texture_source(source, manifest), ensure_ascii=False))
        return
    archive = ROOT/'data/setup/Hunyuan3D-2-source.zip'
    download_archive('https://codeload.github.com/Tencent-Hunyuan/Hunyuan3D-2/zip/'+SOURCE_REV,
                     archive, SOURCE_ZIP_SHA, plan)
    if not plan:
        safe_extract(archive, source.parent)
        print(json.dumps(verify_texture_source(source, manifest), ensure_ascii=False))


def prepare_slicer(plan=False):
    destination = ROOT/'data/tools/prusaslicer-2.9.6'
    executable = destination/'PrusaSlicer-2.9.6/prusa-slicer-console.exe'
    bundled = ROOT/'data/setup/PrusaSlicer-cli-2.9.6.zip'
    if bundled.exists():
        spec=json.loads((ROOT/'tools/setup/slicer-cli-manifest.json').read_text('utf8'))
        if not file_matches(bundled,{'size':bundled.stat().st_size,'sha256':spec['sha256']}):
            raise ValueError('Bundled PrusaSlicer CLI archive hash mismatch')
        archive=bundled
    else:
        archive = ROOT/'data/setup/PrusaSlicer-2.9.6.zip'
        download_archive(SLICER_URL, archive, SLICER_SHA, plan)
    if not plan:
        if executable.exists():
            with zipfile.ZipFile(archive) as stream:
                for entry in stream.infolist():
                    if entry.is_dir():
                        continue
                    path = destination/entry.filename
                    if not path.is_file() or path.is_symlink() or path.read_bytes() != stream.read(entry.filename):
                        raise ValueError('Existing slicer tree differs; use a fresh project directory')
        else:
            safe_extract(archive, destination)
        invoke([executable, '--help'])


def prepare_model(scope, plan=False):
    if scope == 'shape':
        items = shape_files()
        target = ROOT/'data/reconstruction/modelcache/hunyuan3d-2mv'
    else:
        manifest = json.loads((ROOT/'tools/reconstruction/texture_model_manifest.json').read_text('utf-8'))
        items = [dict(item, repo=manifest['repo'], revision=manifest['revision']) for item in manifest['files']
                 if not item['path'].startswith('hunyuan3d-delight-v2-0/')]
        target = ROOT/'data/reconstruction/modelcache/hunyuan3d-paint-probe'
    print(f'{scope}: {len(items)} files, {sum(item["size"] for item in items)/1024**3:.2f} GiB', flush=True)
    for item in items:
        path = target/item['path']
        if file_matches(path, item):
            print('Verified: '+item['path'], flush=True)
            continue
        print('Fetch: '+item['repo']+' @ '+item['revision']+' / '+item['path'], flush=True)
        if plan:
            continue
        if path.exists():
            raise ValueError('Existing model file has wrong identity; move it aside before retry: '+str(path))
        from huggingface_hub import hf_hub_download
        hf_hub_download(repo_id=item['repo'], revision=item['revision'], filename=item['path'],
                        local_dir=target, token=False)
        if not file_matches(path, item):
            raise ValueError('Downloaded model identity mismatch: '+item['path'])
    if not plan:
        from huggingface_hub import hf_hub_download
        for name in ['LICENSE', 'NOTICE', 'README.md']:
            hf_hub_download(repo_id=items[0]['repo'], revision=items[0]['revision'], filename=name,
                            local_dir=target/'metadata', token=False)
        if scope == 'shape':
            metadata = target/'metadata/hunyuan3d-dit-v2-mv__config.yaml'
            shutil.copyfile(target/'hunyuan3d-dit-v2-mv/config.yaml', metadata)
            receipt = {key: items[1][key] for key in ['repo', 'revision', 'path', 'size', 'sha256']}
            receipt['status'] = 'downloaded-and-verified'
            (target/'download-manifest.json').write_text(json.dumps(receipt, indent=2)+'\n', 'utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', action='store_true', help='Print commands without installing or downloading')
    sub = parser.add_subparsers(dest='action', required=True)
    environment = sub.add_parser('environment', help='Create isolated project venvs and install dependencies')
    environment.add_argument('--kind', choices=['cpu', 'cpu-review', 'gpu'], default='cpu')
    environment.add_argument('--wheelhouse', type=Path)
    wheels = sub.add_parser('wheels', help='Download project pip dependencies for later offline installation')
    wheels.add_argument('--kind', choices=['cpu', 'cpu-review', 'gpu'], default='cpu-review')
    wheels.add_argument('--destination', type=Path, default=ROOT/'data/setup/wheels')
    assets = sub.add_parser('assets', help='Fetch fixed public source, slicer and model files')
    assets.add_argument('--scope', choices=['core', 'slicer', 'shape', 'texture', 'all'], default='all')
    args = parser.parse_args()
    if args.action == 'environment':
        prepare_environment(args.kind, args.wheelhouse, args.plan)
    elif args.action == 'wheels':
        prepare_wheels(args.kind, args.destination, args.plan)
    else:
        if args.scope in ('core', 'all'):
            prepare_source(args.plan)
        if args.scope in ('core', 'slicer', 'all'):
            prepare_slicer(args.plan)
        if args.scope in ('shape', 'all'):
            prepare_model('shape', args.plan)
        if args.scope in ('texture', 'all'):
            prepare_model('texture', args.plan)
    print('Plan only; nothing installed.' if args.plan else 'Requested preparation finished. Run the runtime check next.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__+': '+str(error), file=sys.stderr)
        sys.exit(1)
