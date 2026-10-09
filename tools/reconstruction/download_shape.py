"""Download the pinned Hunyuan3D-2mv fp16 shape weights from Hugging Face."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

import requests


MODEL_REPO = "tencent/Hunyuan3D-2mv"
MODEL_REVISION = "3a761b539b29fe4ff64714813aa9560fd66f5de0"
MODEL_RELATIVE_PATH = "hunyuan3d-dit-v2-mv/model.fp16.safetensors"
MODEL_SIZE = 4_928_151_562
MODEL_SHA256 = "d36f5881bcdc56726b73e517cd444c13c60732431622da7268145355c8d38e9c"
CHUNK_SIZE = 32 * 1024 * 1024
MAX_ATTEMPTS_PER_CHUNK = 3
DEFAULT_TOTAL_SECONDS = 8 * 60 * 60
MAX_ALLOWED_TOTAL_SECONDS = 12 * 60 * 60
CONNECT_TIMEOUT_SECONDS = 15
READ_TIMEOUT_SECONDS = 120

ROOT = Path(__file__).resolve().parents[2]
CACHE_ROOT = ROOT / "data" / "reconstruction" / "modelcache" / "hunyuan3d-2mv"
MODEL_DIR = CACHE_ROOT / "hunyuan3d-dit-v2-mv"
MODEL_PATH = MODEL_DIR / "model.fp16.safetensors"
PART_PATH = MODEL_DIR / "model.fp16.safetensors.part"
CONFIG_PATH = MODEL_DIR / "config.yaml"
CONFIG_METADATA_PATH = CACHE_ROOT / "metadata" / "hunyuan3d-dit-v2-mv__config.yaml"
MANIFEST_PATH = CACHE_ROOT / "download-manifest.json"


def _header(headers, name: str) -> str | None:
    wanted = name.lower()
    for key, value in headers.items():
        if str(key).lower() == wanted:
            return str(value)
    return None


def parse_content_range(value: str) -> tuple[int, int, int]:
    """Parse a strict `bytes start-end/total` Content-Range value."""
    match = re.fullmatch(r"bytes\s+(\d+)-(\d+)/(\d+)", value.strip(), flags=re.IGNORECASE)
    if not match:
        raise ValueError("Content-Range is missing or malformed")
    start, end, total = (int(part) for part in match.groups())
    if start > end or total <= end:
        raise ValueError("Content-Range bounds are invalid")
    return start, end, total


def validate_range_response(
    status_code: int,
    headers,
    expected_start: int,
    expected_end: int,
    expected_total: int,
) -> None:
    if status_code != 206:
        raise ValueError("Range request did not return HTTP 206")
    value = _header(headers, "Content-Range")
    if value is None:
        raise ValueError("Range response has no Content-Range")
    actual = parse_content_range(value)
    if actual != (expected_start, expected_end, expected_total):
        raise ValueError("Range response Content-Range did not match the requested bytes")
    content_length = _header(headers, "Content-Length")
    expected_length = expected_end - expected_start + 1
    if content_length is None or not content_length.isdecimal() or int(content_length) != expected_length:
        raise ValueError("Range response Content-Length did not match the requested bytes")


def validate_redirect_location(location: str) -> None:
    parsed = urlsplit(location)
    host = (parsed.hostname or "").lower()
    official_host = (
        host in {"huggingface.co", "hf.co"}
        or host.endswith(".huggingface.co")
        or host.endswith(".hf.co")
    )
    if (
        parsed.scheme != "https"
        or not official_host
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port not in (None, 443)
    ):
        raise ValueError("Hugging Face returned a redirect outside the approved HTTPS hosts")


def validate_hf_identity_headers(headers) -> None:
    revision = _header(headers, "X-Repo-Commit")
    etag = (_header(headers, "X-Linked-Etag") or "").strip().strip('"')
    size = _header(headers, "X-Linked-Size")
    if revision != MODEL_REVISION:
        raise ValueError("Resolved model revision did not match the pinned commit")
    if etag.lower() != MODEL_SHA256:
        raise ValueError("Resolved model SHA-256 did not match the pinned file")
    if size is None or not size.isdecimal() or int(size) != MODEL_SIZE:
        raise ValueError("Resolved model size did not match the pinned file")


def write_range_body(
    response,
    part_path: Path,
    start: int,
    end: int,
    total: int,
    deadline: float | None = None,
) -> int:
    """Append one validated range; roll back this range if its body is incomplete."""
    validate_range_response(response.status_code, response.headers, start, end, total)
    expected_length = end - start + 1
    if part_path.exists() and part_path.stat().st_size != start:
        raise ValueError("Partial file offset does not match the requested range")
    part_path.parent.mkdir(parents=True, exist_ok=True)
    mode = "r+b" if part_path.exists() else "w+b"
    written = 0
    with part_path.open(mode) as output:
        output.seek(start)
        try:
            for block in response.iter_content(chunk_size=1024 * 1024):
                if deadline is not None and time.monotonic() >= deadline:
                    raise TimeoutError("Total model download timeout reached; current range was rolled back")
                if not block:
                    continue
                if written + len(block) > expected_length:
                    raise ValueError("Range response body exceeded its declared length")
                output.write(block)
                written += len(block)
            if written != expected_length:
                raise ValueError("Range response body ended before its declared length")
            output.flush()
            os.fsync(output.fileno())
        except BaseException:
            output.seek(start)
            output.truncate(start)
            output.flush()
            os.fsync(output.fileno())
            raise
    return written


def _git_blob_sha1(payload: bytes) -> str:
    header = f"blob {len(payload)}\0".encode("ascii")
    return hashlib.sha1(header + payload).hexdigest()


def parse_max_seconds(value: int | None) -> int:
    if value is None:
        return DEFAULT_TOTAL_SECONDS
    if isinstance(value, bool) or not isinstance(value, int) or not 300 <= value <= MAX_ALLOWED_TOTAL_SECONDS:
        raise ValueError(f"max-seconds must be between 300 and {MAX_ALLOWED_TOTAL_SECONDS}")
    return value


def throughput_mib_per_second(downloaded_bytes: int, elapsed_seconds: float) -> float:
    elapsed = max(elapsed_seconds, 0.001)
    return downloaded_bytes / (1024 * 1024) / elapsed


def ensure_config() -> None:
    """Materialize the already fetched, revision-matched official config."""
    if not CONFIG_METADATA_PATH.is_file():
        raise FileNotFoundError(f"Pinned config metadata is missing: {CONFIG_METADATA_PATH}")
    payload = CONFIG_METADATA_PATH.read_bytes()
    if len(payload) != 1608 or _git_blob_sha1(payload) != "7a9b1f3b1ca62e16a24257b8e8328573d299c5e4":
        raise ValueError("Cached config does not match the pinned HF model revision")
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    if CONFIG_PATH.exists():
        existing = CONFIG_PATH.read_bytes()
        if existing != payload:
            raise FileExistsError("A different config already exists at the pinned model path")
        return
    fd, temporary_name = tempfile.mkstemp(prefix=".config-", suffix=".tmp", dir=MODEL_DIR)
    try:
        with os.fdopen(fd, "wb") as temporary:
            temporary.write(payload)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, CONFIG_PATH)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def _resolve_signed_url(session: requests.Session) -> str:
    resolve_url = (
        f"https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_REVISION}/{MODEL_RELATIVE_PATH}"
    )
    response = session.head(
        resolve_url,
        allow_redirects=False,
        timeout=(CONNECT_TIMEOUT_SECONDS, READ_TIMEOUT_SECONDS),
    )
    try:
        validate_hf_identity_headers(response.headers)
        if response.status_code != 302:
            raise ValueError("Pinned Hugging Face file did not return its expected HTTPS redirect")
        location = response.headers.get("Location")
        if not location:
            raise ValueError("Hugging Face response did not provide a signed file location")
        validate_redirect_location(location)
        return location
    finally:
        response.close()


def _download_chunk(session: requests.Session, start: int, end: int, deadline: float) -> int:
    for attempt in range(1, MAX_ATTEMPTS_PER_CHUNK + 1):
        if time.monotonic() >= deadline:
            raise TimeoutError("Total model download timeout reached; current offset is preserved")
        response = None
        try:
            signed_url = _resolve_signed_url(session)
            response = session.get(
                signed_url,
                headers={"Range": f"bytes={start}-{end}"},
                allow_redirects=False,
                stream=True,
                timeout=(
                    CONNECT_TIMEOUT_SECONDS,
                    max(1, min(READ_TIMEOUT_SECONDS, int(deadline - time.monotonic()))),
                ),
            )
            return write_range_body(response, PART_PATH, start, end, MODEL_SIZE, deadline=deadline)
        except (requests.RequestException, OSError, ValueError) as error:
            if isinstance(error, TimeoutError):
                raise
            if attempt >= MAX_ATTEMPTS_PER_CHUNK:
                raise RuntimeError(
                    f"Range {start}-{end} failed after {attempt} attempts; offset {start} is preserved ({type(error).__name__})"
                ) from error
            delay = min(2 ** (attempt - 1), 2)
            print(
                f"Range {start}-{end} attempt {attempt}/{MAX_ATTEMPTS_PER_CHUNK} failed "
                f"({type(error).__name__}); retrying in {delay}s at the same offset",
                flush=True,
            )
            time.sleep(delay)
        finally:
            if response is not None:
                response.close()
    raise RuntimeError("Unreachable download retry state")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def status() -> int:
    part_size = PART_PATH.stat().st_size if PART_PATH.exists() else 0
    final_size = MODEL_PATH.stat().st_size if MODEL_PATH.exists() else 0
    print(f"repo={MODEL_REPO}")
    print(f"revision={MODEL_REVISION}")
    print(f"file={MODEL_RELATIVE_PATH}")
    print(f"part_bytes={part_size}/{MODEL_SIZE}")
    print(f"final_bytes={final_size}")
    if MODEL_PATH.exists():
        print(f"final_sha256={_sha256_file(MODEL_PATH)}")
    return 0


def download(max_seconds: int = DEFAULT_TOTAL_SECONDS) -> Path:
    max_seconds = parse_max_seconds(max_seconds)
    ensure_config()
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    if MODEL_PATH.exists():
        if MODEL_PATH.stat().st_size == MODEL_SIZE and _sha256_file(MODEL_PATH) == MODEL_SHA256:
            print(f"Already verified: {MODEL_PATH}")
            return MODEL_PATH
        raise FileExistsError("An unverified file already exists at the final model path")

    offset = PART_PATH.stat().st_size if PART_PATH.exists() else 0
    if offset > MODEL_SIZE:
        raise ValueError("Partial model file is larger than the pinned file")
    if offset == MODEL_SIZE:
        digest = _sha256_file(PART_PATH)
        if digest != MODEL_SHA256:
            raise ValueError("Full-size partial file failed SHA-256 verification; it was preserved")
    else:
        session = requests.Session()
        deadline = time.monotonic() + max_seconds
        started = time.monotonic()
        initial_offset = offset
        try:
            while offset < MODEL_SIZE:
                end = min(offset + CHUNK_SIZE - 1, MODEL_SIZE - 1)
                _download_chunk(session, offset, end, deadline)
                offset = end + 1
                elapsed = max(time.monotonic() - started, 0.001)
                mib_per_second = throughput_mib_per_second(offset - initial_offset, elapsed)
                print(
                    f"downloaded={offset}/{MODEL_SIZE} ({100 * offset / MODEL_SIZE:.2f}%) "
                    f"average={mib_per_second:.2f}MiB/s",
                    flush=True,
                )
        finally:
            session.close()
        digest = _sha256_file(PART_PATH)
        if digest != MODEL_SHA256:
            raise ValueError("Downloaded model failed SHA-256 verification; partial file was preserved")

    os.replace(PART_PATH, MODEL_PATH)
    manifest = {
        "repo": MODEL_REPO,
        "revision": MODEL_REVISION,
        "path": MODEL_RELATIVE_PATH,
        "size": MODEL_SIZE,
        "sha256": MODEL_SHA256,
    }
    temporary_manifest = MANIFEST_PATH.with_suffix(".json.tmp")
    temporary_manifest.write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary_manifest, MANIFEST_PATH)
    print(f"verified_sha256={digest}")
    print(f"model_path={MODEL_PATH}")
    return MODEL_PATH


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--status", action="store_true", help="show the fixed model download status")
    parser.add_argument(
        "--max-seconds",
        type=int,
        default=DEFAULT_TOTAL_SECONDS,
        help=f"total time limit for this run (300 to {MAX_ALLOWED_TOTAL_SECONDS} seconds; default 8h)",
    )
    args = parser.parse_args()
    if args.status:
        return status()
    try:
        download(args.max_seconds)
    except ValueError as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
