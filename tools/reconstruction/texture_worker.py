"""Bounded texture worker. The Paint CLI runs in this managed Python process."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import os
import re
import runpy
import shutil
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools" / "reconstruction"
sys.path.insert(0, str(TOOLS))
from texture_delivery_core import (  # noqa: E402
    MODEL_REVISION, PROFILES, TRANSFORM, TextureDeliveryError,
    digest_file, geometry_signature, load_source_mesh, transform_mesh_yup_metres,
    validate_job_paths, verify_delivery,
)
from texture_source_pins import (  # noqa: E402
    PINNED_SOURCE_REVISION, PINNED_SOURCE_TREE, verify_texture_source,
)

CODES = {
    "TEXTURE_GPU_BUSY", "TEXTURE_RESOURCE_FAILURE", "TEXTURE_ENGINE_FAILURE",
    "TEXTURE_SOURCE_CHANGED", "TEXTURE_RESULT_INVALID", "TEXTURE_INPUT_INVALID",
}
HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")
REQUEST_FILE = re.compile(r"^request-(generate|verify)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$")
ACTIVE_PROCESS_MARKER: Path | None = None


def _read_request(path: Path) -> dict:
    try:
        raw = path.read_bytes()
        if len(raw) > 64 * 1024:
            raise TextureDeliveryError("request exceeds 64 KiB")
        request = json.loads(raw.decode("utf-8"))
    except TextureDeliveryError:
        raise
    except (OSError, UnicodeError, ValueError) as exc:
        raise TextureDeliveryError("request JSON is invalid") from exc
    if not isinstance(request, dict):
        raise TextureDeliveryError("request must be a JSON object")
    required = ("mode", "jobId", "attemptId", "profile", "sourceStlPath", "sourceSha256",
                "referenceImagePath", "referenceSha256", "outputDir")
    if set(request) != set(required):
        raise TextureDeliveryError("request is missing required fields")
    if not isinstance(request["mode"], str) or request["mode"] not in ("generate", "verify"):
        raise TextureDeliveryError("mode must be generate or verify")
    if not isinstance(request["profile"], str) or request["profile"] not in PROFILES:
        raise TextureDeliveryError("profile must be standard or compact")
    for key in ("jobId", "attemptId", "sourceStlPath", "referenceImagePath", "outputDir"):
        value = request[key]
        if not isinstance(value, str) or not value or "\0" in value or len(value) > 32767:
            raise TextureDeliveryError(f"{key} must be a bounded path or identifier string")
    for key in ("sourceSha256", "referenceSha256"):
        if not isinstance(request[key], str) or not HEX_SHA256.fullmatch(request[key]):
            raise TextureDeliveryError(f"{key} must be lowercase SHA-256")
    return request


def _verify_source_and_model_pins() -> dict:
    source_root = ROOT / "data" / "reconstruction" / "source-f8db630" / "Hunyuan3D-2-f8db63096c8282cb27354314d896feba5ba6ff8a"
    source_manifest = json.loads((TOOLS / "texture_source_manifest.json").read_text(encoding="utf-8"))
    source_evidence = verify_texture_source(source_root, source_manifest)
    manifest = json.loads((TOOLS / "texture_model_manifest.json").read_text(encoding="utf-8"))
    if manifest.get("revision") != MODEL_REVISION:
        raise TextureDeliveryError("model revision differs from pinned revision")
    cache = ROOT / "data" / "reconstruction" / "modelcache" / "hunyuan3d-paint-probe"
    for item in manifest.get("files", []):
        if item["path"].startswith("hunyuan3d-delight-v2-0/"):
            continue
        file_path = cache / item["path"]
        if not file_path.is_file() or file_path.is_symlink() or file_path.stat().st_size != item["size"]:
            raise TextureDeliveryError("required pinned model file is missing or has wrong length")
        contents_hash = digest_file(file_path)
        if item.get("sha256"):
            if contents_hash != item["sha256"]:
                raise TextureDeliveryError("pinned model file hash mismatch")
        else:
            contents = file_path.read_bytes()
            blob = hashlib.sha1(b"blob " + str(len(contents)).encode("ascii") + b"\0" + contents).hexdigest()
            if blob != item.get("gitBlobId"):
                raise TextureDeliveryError("pinned model config blob mismatch")
    return source_evidence


def _safe_log_write(path: Path, text: str) -> None:
    # Prevent terminal/control output from the model CLI; logs remain job-private.
    path.write_text(text[:4_000_000], encoding="utf-8", errors="replace")


def _write_process_marker(output: Path) -> None:
    """Publish the actual Python worker PID for the supervising Node process."""
    global ACTIVE_PROCESS_MARKER
    marker = output / "worker-process.json"
    marker.write_text(json.dumps({"pid": os.getpid(), "startedAtEpochNs": time.time_ns()}, separators=(",", ":")), encoding="utf-8")
    ACTIVE_PROCESS_MARKER = marker


def _validate_internal_request_file(request_path: Path, output: Path, mode: str) -> None:
    """Require Node's single UUID-named request file inside this attempt."""
    try:
        request_path = Path(os.path.abspath(request_path))
        output = Path(os.path.abspath(output))
        match = REQUEST_FILE.fullmatch(request_path.name)
        if request_path.parent != output or match is None or match.group(1) != mode:
            raise TextureDeliveryError("request file must be inside the fixed attempt directory")
        request_id = match.group(2)
        if str(uuid.UUID(request_id)) != request_id:
            raise TextureDeliveryError("request file name must contain a canonical UUID")
        output_info = output.lstat()
        request_info = request_path.lstat()
        if (output.is_symlink() or request_path.is_symlink()
                or getattr(output_info, "st_file_attributes", 0) & 0x400
                or getattr(request_info, "st_file_attributes", 0) & 0x400
                or not request_path.is_file() or request_info.st_nlink != 1
                or output.resolve(strict=True) != output or request_path.resolve(strict=True) != request_path):
            raise TextureDeliveryError("request file or attempt path is linked or invalid")
    except TextureDeliveryError:
        raise
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        raise TextureDeliveryError("request file or attempt path is invalid") from exc


def _validate_fresh_attempt(output: Path, request_path: Path, mode: str) -> None:
    _validate_internal_request_file(request_path, output, mode)
    if {child.name for child in output.iterdir()} != {request_path.name}:
        raise TextureDeliveryError("attempt output contains files from a previous run")


def _probe_failure_code(output: Path) -> str | None:
    """Map only explicit exception types recorded by the real CLI."""
    try:
        report = json.loads((output / "probe-work" / "texture-probe.json").read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError):
        return None
    if not isinstance(report, dict) or report.get("status") != "failed":
        return None
    if report.get("exception") == "GPU_BUSY":
        return "TEXTURE_GPU_BUSY"
    if report.get("exception") in ("OutOfMemoryError", "MemoryError"):
        return "TEXTURE_RESOURCE_FAILURE"
    return None


def _probe_report(output: Path) -> dict:
    try:
        report = json.loads((output / "texture-probe.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as exc:
        raise TextureDeliveryError("Paint CLI did not produce a valid probe report") from exc
    if not isinstance(report, dict) or report.get("status") != "generated-awaiting-visual-review":
        raise RuntimeError("Paint CLI did not complete generation")
    return report


def _run_generate(request: dict, paths: dict, source_evidence: dict, request_path: Path) -> dict:
    source = paths["source"]
    reference = paths["reference"]
    output = paths["output"]
    if not output.is_dir():
        raise TextureDeliveryError("attempt output directory is missing")
    _validate_fresh_attempt(output, request_path, request["mode"])
    _write_process_marker(output)
    work = output / "probe-work"
    work.mkdir()
    mesh = load_source_mesh(source)
    converted = transform_mesh_yup_metres(mesh)
    converted_mesh = output / "source-yup-metres.glb"
    converted.export(converted_mesh, file_type="glb")
    prepared = load_source_mesh(converted_mesh)
    if len(prepared.faces) != len(mesh.faces) or geometry_signature(prepared.vertices, prepared.faces) != geometry_signature(converted.vertices, converted.faces):
        raise TextureDeliveryError("prepared GLB changed exact-merged source geometry")
    original_source_hash = digest_file(source)
    original_reference_hash = digest_file(reference)
    if original_source_hash != request["sourceSha256"] or original_reference_hash != request["referenceSha256"]:
        raise TextureDeliveryError("source or reference hash changed")
    run_id = f"texture-{request['jobId']}-{request['attemptId']}"
    profile = PROFILES[request["profile"]]
    probe_script = TOOLS / "run_texture_probe.py"
    options = [
        str(probe_script), "--mesh", str(converted_mesh), "--image", str(reference),
        "--run-id", run_id, "--render-size", str(profile["renderSize"]),
        "--texture-size", str(profile["textureSize"]), "--views", str(profile["views"]),
        "--offload", "model", "--skip-delight",
    ]
    # run_texture_probe imports this function before using its fixed experiment path.
    # Redirect its requested experiment directory to this attempt's private work area.
    import texture_probe_core
    requested_root = ROOT / "data" / "texture-experiments" / run_id

    def private_output_dir(requested):
        if Path(requested) != requested_root:
            raise RuntimeError("unexpected Paint CLI output path")
        if work.exists() and any(work.iterdir()):
            raise RuntimeError("private probe output is already populated")
        return work

    original_ensure = texture_probe_core.ensure_new_output_directory
    texture_probe_core.ensure_new_output_directory = private_output_dir
    captured = io.StringIO()
    saved_argv = sys.argv
    started = time.monotonic()
    try:
        sys.argv = options
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            runpy.run_path(str(probe_script), run_name="__main__")
    except SystemExit as exc:
        if exc.code not in (0, None):
            raise RuntimeError(f"Paint CLI exited with code {exc.code}") from exc
    finally:
        sys.argv = saved_argv
        texture_probe_core.ensure_new_output_directory = original_ensure
        _safe_log_write(output / "worker.log", captured.getvalue())
    report = _probe_report(work)
    if digest_file(source) != original_source_hash or digest_file(reference) != original_reference_hash:
        raise TextureDeliveryError("source or reference changed during generation")
    if not source_evidence or report.get("sourceVerification") != source_evidence:
        raise RuntimeError("Paint CLI source verification differs from independent source pin check")
    if report.get("modelRevision") != MODEL_REVISION:
        raise RuntimeError("Paint CLI model revision differs from pinned model")
    glb = work / "textured.glb"
    atlas = work / "texture-atlas.png"
    if not glb.is_file() or not atlas.is_file():
        raise RuntimeError("Paint CLI did not produce GLB and texture atlas")
    shutil.copyfile(glb, output / "textured.glb")
    shutil.copyfile(atlas, output / "texture-atlas.png")
    shutil.copyfile(work / "texture-probe.json", output / "texture-probe.json")
    probe_path = output / "texture-probe.json"
    report["sourceStlSha256"] = original_source_hash
    report["referenceImageSha256"] = original_reference_hash
    report["requestedProfile"] = request["profile"]
    report["expectedCoordinateTransform"] = TRANSFORM
    report["runId"] = run_id
    probe_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if digest_file(source) != original_source_hash or digest_file(reference) != original_reference_hash:
        raise TextureDeliveryError("source or reference changed before result verification")
    glb_hash = digest_file(output / "textured.glb")
    metrics = {
        "faces": len(mesh.faces), "textureSizePixels": list(report.get("textureSizePixels", [])),
        "geometryPreservedAtFloat32": report.get("geometryPreservedAtFloat32") is True,
        "peakAllocatedGpuMiB": report.get("peakAllocatedGpuMiB"),
        "elapsedSeconds": report.get("elapsedSeconds"),
    }
    result = {
        "success": True, "code": "OK", "attemptId": request["attemptId"], "profile": request["profile"],
        "sourceSha256": original_source_hash, "referenceSha256": original_reference_hash,
        "glbSha256": glb_hash, "glbBytes": (output / "textured.glb").stat().st_size,
        "metrics": metrics,
        "proof": {
            "inputGeometrySignature": report.get("inputGeometrySignature"),
            "outputGeometrySignature": report.get("outputGeometrySignature"),
            "coordinateTransform": TRANSFORM, "modelRevision": MODEL_REVISION,
            "sourceRevision": PINNED_SOURCE_REVISION,
        },
    }
    (output / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    verified = verify_delivery(
        paths["root"], request["jobId"], request["attemptId"], source, reference, output,
        original_source_hash, original_reference_hash, request["profile"],
    )
    return {"success": True, "code": "OK", "attemptId": request["attemptId"], "profile": request["profile"],
            "sourceSha256": original_source_hash, "referenceSha256": original_reference_hash,
            "glbSha256": verified["glbSha256"], "glbBytes": verified["glbBytes"],
            "metrics": verified["metrics"], "proof": verified["proof"]}


def _run_verify(request: dict, paths: dict) -> dict:
    source_evidence = _verify_source_and_model_pins()
    result = verify_delivery(
        paths["root"], request["jobId"], request["attemptId"], paths["source"], paths["reference"],
        paths["output"], request["sourceSha256"], request["referenceSha256"], request["profile"],
    )
    # The CLI's embedded verification receipt is tied to the files actually checked here.
    report = json.loads((paths["output"] / "texture-probe.json").read_text(encoding="utf-8"))
    if report.get("sourceVerification") != source_evidence:
        raise TextureDeliveryError("source verification receipt differs from current pinned source")
    if report.get("sourceStlSha256") != request["sourceSha256"] or report.get("referenceImageSha256") != request["referenceSha256"]:
        raise TextureDeliveryError("probe source binding does not match verify request")
    if report.get("requestedProfile") != request["profile"] or report.get("expectedCoordinateTransform") != TRANSFORM:
        raise TextureDeliveryError("probe profile or coordinate frame differs from request")
    return {"success": True, "code": "OK", "attemptId": request["attemptId"], "profile": request["profile"],
            "sourceSha256": request["sourceSha256"], "referenceSha256": request["referenceSha256"],
            **result}


def _classify(exc: BaseException, output: Path | None, mode: str | None = None) -> str:
    if isinstance(exc, TextureDeliveryError):
        message = str(exc).lower()
        if "hash changed" in message or "source or reference hash mismatch" in message or "changed during" in message:
            return "TEXTURE_SOURCE_CHANGED"
        if mode == "verify":
            if any(marker in message for marker in ("path", "uuid", "profile must", "unknown profile", "source stl", "source exceeds", "reference", "face count", "job directory")):
                return "TEXTURE_INPUT_INVALID"
            return "TEXTURE_RESULT_INVALID"
        if ("generated glb" in message or "report" in message or "result" in message
                or "geometry" in message or "texture" in message or "output face" in message):
            return "TEXTURE_RESULT_INVALID"
        return "TEXTURE_INPUT_INVALID"
    if type(exc).__name__ == "GPU_BUSY":
        return "TEXTURE_GPU_BUSY"
    if type(exc).__name__ == "OutOfMemoryError" and "cuda out of memory" in str(exc).lower():
        return "TEXTURE_RESOURCE_FAILURE"
    if mode == "generate" and output is not None:
        code = _probe_failure_code(output)
        if code is not None:
            return code
    return "TEXTURE_ENGINE_FAILURE"


def execute(request_path: Path) -> dict:
    request = _read_request(request_path)
    jobs_root = ROOT / "data" / "texture" / "jobs"
    paths = validate_job_paths(jobs_root, request["jobId"], request["attemptId"], request["sourceStlPath"], request["referenceImagePath"], request["outputDir"])
    if request["mode"] == "generate":
        # Create output only after all request paths, bounds and bindings are valid.
        _validate_fresh_attempt(paths["output"], request_path, request["mode"])
        for name, key in (("source", "sourceSha256"), ("reference", "referenceSha256")):
            if digest_file(paths[name]) != request[key]:
                raise TextureDeliveryError(f"{name} hash changed")
        source_evidence = _verify_source_and_model_pins()
        return _run_generate(request, paths, source_evidence, request_path)
    _validate_internal_request_file(request_path, paths["output"], request["mode"])
    _write_process_marker(paths["output"])
    return _run_verify(request, paths)


def _consume_owned_start(stream) -> bool:
    """Accept exactly one complete start line and no trailing input."""
    try:
        return stream.readline() == "TEXTURE_START\n" and stream.read() == ""
    except (OSError, UnicodeError):
        return False


def main(argv=None) -> int:
    global ACTIVE_PROCESS_MARKER
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--owned-start", action="store_true", help="wait for the Windows job-object owner start handshake")
    args = parser.parse_args(argv)
    if args.owned_start and not _consume_owned_start(sys.stdin):
        print(json.dumps({"success": False, "code": "TEXTURE_INPUT_INVALID",
                          "message": "owned worker start handshake is missing or invalid",
                          "workerPid": os.getpid()}, ensure_ascii=False, separators=(",", ":")))
        return 1
    request = None
    output = None
    try:
        request = _read_request(args.request)
        output = Path(request.get("outputDir", "")) if isinstance(request.get("outputDir"), str) else None
        result = execute(args.request)
    except BaseException as exc:
        code = _classify(exc, output, request.get("mode") if isinstance(request, dict) else None)
        result = {"success": False, "code": code}
        if isinstance(request, dict):
            for key in ("attemptId", "profile", "sourceSha256", "referenceSha256"):
                if key in request:
                    result[key] = request[key]
        result["message"] = str(exc).split("https:")[0][:1000]
        result["workerPid"] = os.getpid()
        if ACTIVE_PROCESS_MARKER is not None:
            try:
                ACTIVE_PROCESS_MARKER.unlink(missing_ok=True)
            except OSError:
                pass
            ACTIVE_PROCESS_MARKER = None
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 1
    result["workerPid"] = os.getpid()
    if ACTIVE_PROCESS_MARKER is not None:
        try:
            ACTIVE_PROCESS_MARKER.unlink(missing_ok=True)
        except OSError:
            pass
        ACTIVE_PROCESS_MARKER = None
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
