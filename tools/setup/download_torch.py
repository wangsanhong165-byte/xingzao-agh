"""Resumable official Torch wheel download for Windows x64 / Python 3.12.

Use when pip's single large download stalls. Parts are retained on failure;
the final wheel is installed only after its official SHA-256 matches.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import os
from pathlib import Path
import shutil
import time
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
URL = 'https://download-r2.pytorch.org/whl/cu130/torch-2.11.0%2Bcu130-cp312-cp312-win_amd64.whl'
SIZE = 1915224818
SHA = 'ef8beae16d781c3244ef28dc7bee6d8871c26bbde65d5bf66e902cb61972c4ab'
NAME = 'torch-2.11.0+cu130-cp312-cp312-win_amd64.whl'
CHUNK = 32*1024*1024


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(8*1024*1024), b''):
            digest.update(block)
    return digest.hexdigest()


def download():
    output = ROOT/'data/setup/wheels'
    output.mkdir(parents=True, exist_ok=True)
    target = output/NAME
    if target.exists():
        if target.stat().st_size == SIZE and sha(target) == SHA:
            print('Torch wheel verified: '+str(target)); return
        raise ValueError('Existing Torch wheel differs; move it aside before retrying')
    if shutil.disk_usage(output).free < SIZE*2:
        raise OSError('Need at least 4GB free space for download parts and assembly')
    parts = output/'torch-cu130.parts'
    parts.mkdir(exist_ok=True)
    deadline = time.monotonic()+1800

    def fetch(index):
        start = index*CHUNK
        end = min(SIZE-1, start+CHUNK-1)
        path = parts/f'{index:04d}.part'
        if path.is_file() and path.stat().st_size == end-start+1:
            return path
        for attempt in range(3):
            if time.monotonic() >= deadline:
                raise TimeoutError('Download deadline reached; completed parts were retained')
            temporary = path.with_suffix('.pending')
            try:
                request = Request(URL, headers={'Range': f'bytes={start}-{end}', 'Accept-Encoding': 'identity',
                                                'User-Agent': 'python-requests/2.34.2'})
                with urlopen(request, timeout=30) as response, temporary.open('wb') as stream:
                    content_range = response.headers.get('Content-Range', '')
                    if response.status != 206 or content_range != f'bytes {start}-{end}/{SIZE}':
                        raise ValueError('Server did not honor the requested exact range')
                    received = 0
                    while True:
                        if time.monotonic() >= deadline:
                            raise TimeoutError('Download deadline reached')
                        block = response.read(1024*1024)
                        if not block: break
                        received += len(block)
                        if received > end-start+1:
                            raise ValueError('Range body exceeds declared bytes')
                        stream.write(block)
                    if received != end-start+1:
                        raise ValueError('Range body is incomplete')
                os.replace(temporary, path)
                return path
            except Exception:
                if temporary.exists(): temporary.unlink()
                if attempt == 2: raise
                time.sleep(1)
    count = (SIZE+CHUNK-1)//CHUNK
    workers = ThreadPoolExecutor(max_workers=4)
    try:
        tasks = [workers.submit(fetch, index) for index in range(count)]
        for completed, task in enumerate(as_completed(tasks), 1):
            task.result()
            print(f'Torch download parts: {completed}/{count}', flush=True)
    finally:
        workers.shutdown(wait=True, cancel_futures=True)
    merged = target.with_suffix('.pending')
    with merged.open('wb') as stream:
        for index in range(count):
            with (parts/f'{index:04d}.part').open('rb') as part:
                shutil.copyfileobj(part, stream, 1024*1024)
    if merged.stat().st_size != SIZE or sha(merged) != SHA:
        raise ValueError('Final Torch SHA-256 mismatch; no wheel was installed')
    os.replace(merged, target)
    print('Torch wheel verified: '+str(target), flush=True)


if __name__ == '__main__':
    download()
