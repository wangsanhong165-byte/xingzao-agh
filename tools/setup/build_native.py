"""Build both texture extensions from verified source in a project-owned copy.

Run from an x64 Native Tools Command Prompt with CUDA 13.0 installed.
This wrapper carries the actual Windows build settings; it does not patch
PyTorch headers, the checked source tree, global PATH or the parent interpreter.
"""
import argparse
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'tools/reconstruction'))
from texture_source_pins import verify_texture_source


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--component', choices=['rasterizer', 'mesh', 'all'], default='all')
    parser.add_argument('--output', type=Path, default=ROOT/'data/setup/wheels')
    parser.add_argument('--build-root', type=Path, default=ROOT/'data/setup/native-build')
    args = parser.parse_args()
    source = ROOT/'data/reconstruction/source-f8db630/Hunyuan3D-2-f8db63096c8282cb27354314d896feba5ba6ff8a'
    manifest = json.loads((ROOT/'tools/reconstruction/texture_source_manifest.json').read_text('utf-8'))
    verify_texture_source(source, manifest)
    if sys.platform != 'win32' or sys.version_info[:2] != (3, 12):
        raise RuntimeError('This build recipe targets Windows x64 / Python 3.12')
    if not shutil.which('cl.exe'):
        raise RuntimeError('Open x64 Native Tools Command Prompt for VS2022 before building')
    import torch
    if torch.__version__ != '2.11.0+cu130':
        raise RuntimeError('Install the pinned Torch 2.11.0+cu130 in the texture venv first')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    args.build_root.mkdir(parents=True, exist_ok=True)
    if args.component in ('rasterizer', 'all'):
        import torch.utils.cpp_extension as extension
        if not extension.CUDA_HOME or not (Path(extension.CUDA_HOME)/'bin/nvcc.exe').exists():
            raise RuntimeError('CUDA 13.0 Toolkit / nvcc not found; set CUDA_HOME in this terminal')
        extension.SUBPROCESS_DECODE_ARGS = ('utf-8', 'replace')
        extension.BuildExtension = extension.BuildExtension.with_options(use_ninja=False)
        os.environ.update(TORCH_CUDA_ARCH_LIST='12.0', MAX_JOBS='1', VSLANG='1033',
                          DISTUTILS_USE_SDK='1', CL='/permissive- /Zc:__cplusplus /EHsc')
        destination = args.build_root/'rasterizer'
        shutil.copytree(source/'hy3dgen/texgen/custom_rasterizer', destination, dirs_exist_ok=True)
        os.chdir(destination)
        sys.argv = ['setup.py', 'bdist_wheel', '--dist-dir', str(output)]
        runpy.run_path(str(destination/'setup.py'), run_name='__main__')
    if args.component in ('mesh', 'all'):
        destination = args.build_root/'mesh'
        destination.mkdir(parents=True, exist_ok=True)
        for filename in ['setup.py', 'mesh_processor.cpp']:
            shutil.copyfile(source/'hy3dgen/texgen/differentiable_renderer'/filename, destination/filename)
        subprocess.run([sys.executable, 'setup.py', 'bdist_wheel', '--dist-dir', str(output)],
                       cwd=destination, check=True)
    print('Native wheels: '+str(output))


if __name__ == '__main__':
    main()
