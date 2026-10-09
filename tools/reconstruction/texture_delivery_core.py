"""CPU-verifiable guards and evidence checks for texture job delivery."""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import struct
import uuid
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image

from texture_probe_core import geometry_signature, validate_mesh_bounds
from texture_source_pins import PINNED_SOURCE_REVISION, PINNED_SOURCE_TREE

MODEL_REVISION = "9cd649ba6913f7a852e3286bad86bfa9a2d83dcf"
PROFILES = {
    "standard": {"renderSize": 1024, "textureSize": 2048, "views": 6},
    "compact": {"renderSize": 512, "textureSize": 1024, "views": 4},
}
SHA256 = re.compile(r"^[0-9a-f]{64}$")
TRANSFORM = "Z-up mm to Y-up metres [x,z,-y]/1000"


class TextureDeliveryError(ValueError):
    """A request or independently verified delivery violates its contract."""


def digest_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def _is_reparse(path: Path) -> bool:
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def _check_chain_no_links(path: Path, stop: Path) -> None:
    path = Path(os.path.abspath(path))
    stop = Path(os.path.abspath(stop))
    try:
        relative = path.relative_to(stop)
    except ValueError as exc:
        raise TextureDeliveryError("path escapes texture job root") from exc
    for ancestor in reversed((stop, *stop.parents)):
        if ancestor.exists() and _is_reparse(ancestor):
            raise TextureDeliveryError("job root chain contains a link")
    cursor = stop
    for part in relative.parts:
        cursor /= part
        try:
            if _is_reparse(cursor):
                raise TextureDeliveryError("job path contains a link")
        except FileNotFoundError:
            break


def validate_job_paths(jobs_root, job_id, attempt_id, source_path, reference_path, output_dir):
    """Validate canonical job/attempt paths and reject links or escapes."""
    try:
        canonical_id = str(uuid.UUID(job_id))
    except (ValueError, TypeError, AttributeError) as exc:
        raise TextureDeliveryError("invalid job UUID") from exc
    if canonical_id != job_id:
        raise TextureDeliveryError("job UUID must be canonical")
    if attempt_id not in ("t01", "t02"):
        raise TextureDeliveryError("attempt must be t01 or t02")
    root = Path(os.path.abspath(jobs_root))
    job_root = root / canonical_id
    try:
        if not job_root.is_dir():
            raise TextureDeliveryError("job directory is missing")
        if _is_reparse(root) or _is_reparse(job_root):
            raise TextureDeliveryError("job path contains a link")
    except OSError as exc:
        raise TextureDeliveryError("cannot inspect job directory") from exc

    paths = {}
    for name, value in (("source", source_path), ("reference", reference_path)):
        path = Path(os.path.abspath(value))
        _check_chain_no_links(path, job_root)
        try:
            resolved = path.resolve(strict=True)
            resolved.relative_to(job_root.resolve(strict=True))
            info = path.stat()
        except (OSError, ValueError) as exc:
            raise TextureDeliveryError(f"{name} path is missing or escapes job") from exc
        if not stat.S_ISREG(info.st_mode):
            raise TextureDeliveryError(f"{name} path must be a regular file")
        if getattr(info, "st_nlink", 1) > 1:
            raise TextureDeliveryError(f"{name} path must not be a hard link")
        paths[name] = resolved
    out = Path(os.path.abspath(output_dir))
    if out != job_root / attempt_id:
        raise TextureDeliveryError("output path must be the fixed job attempt directory")
    _check_chain_no_links(out, job_root)
    if out.exists() and not out.is_dir():
        raise TextureDeliveryError("attempt output path must be a directory")
    paths.update({"root": root, "jobRoot": job_root, "output": out})
    return paths


def load_source_mesh(source_path: Path):
    label = "source STL" if source_path.suffix.lower() == ".stl" else "prepared mesh"
    size = source_path.stat().st_size
    if size > 25 * 1024 * 1024:
        raise TextureDeliveryError(f"{label} exceeds 25 MiB")
    try:
        mesh = trimesh.load(source_path, process=False, force="mesh")
    except Exception as exc:
        raise TextureDeliveryError(f"{label} cannot be decoded") from exc
    validate_mesh_bounds(len(mesh.faces), size)
    if len(mesh.faces) == 0 or len(mesh.vertices) == 0:
        raise TextureDeliveryError(f"{label} has no triangles")
    if not np.isfinite(mesh.vertices).all():
        raise TextureDeliveryError(f"{label} has non-finite coordinates")
    before = geometry_signature(mesh.vertices, mesh.faces)
    # STL stores each triangle's vertices independently. Weld only exact
    # coordinate matches so xatlas sees connected topology without moving or
    # quantizing any point and without changing face order or winding.
    unique_vertices, inverse = np.unique(np.asarray(mesh.vertices), axis=0, return_inverse=True)
    remapped_faces = inverse[np.asarray(mesh.faces, dtype=np.int64)]
    welded = trimesh.Trimesh(
        vertices=unique_vertices,
        faces=remapped_faces,
        process=False,
    )
    if len(welded.faces) != len(mesh.faces) or geometry_signature(welded.vertices, welded.faces) != before:
        raise TextureDeliveryError("exact vertex merge changed oriented source geometry")
    return welded


def transform_mesh_yup_metres(mesh):
    """Map Z-up/mm vertices to Y-up/metres, retaining faces and winding."""
    transformed = mesh.copy()
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    transformed.vertices = np.column_stack((vertices[:, 0], vertices[:, 2], -vertices[:, 1])) / 1000.0
    transformed.faces = np.asarray(mesh.faces).copy()
    return transformed


def _glb_document(path: Path) -> dict:
    raw = path.read_bytes()
    if len(raw) < 20 or raw[:4] != b"glTF":
        raise TextureDeliveryError("output is not a binary GLB")
    version, total = struct.unpack_from("<II", raw, 4)
    if version != 2 or total != len(raw):
        raise TextureDeliveryError("GLB header or length is invalid")
    offset = 12
    document = None
    while offset < len(raw):
        if offset + 8 > len(raw):
            raise TextureDeliveryError("GLB chunk header is truncated")
        length, kind = struct.unpack_from("<I4s", raw, offset)
        offset += 8
        if offset + length > len(raw):
            raise TextureDeliveryError("GLB chunk is truncated")
        chunk = raw[offset:offset + length]
        offset += length
        if kind == b"JSON":
            if document is not None:
                raise TextureDeliveryError("GLB has multiple JSON chunks")
            try:
                document = json.loads(chunk.decode("utf-8").rstrip(" \t\r\n\0"))
            except (UnicodeError, ValueError) as exc:
                raise TextureDeliveryError("GLB JSON is invalid") from exc
    if document is None:
        raise TextureDeliveryError("GLB JSON chunk is missing")
    for buffer in document.get("buffers", []):
        if "uri" in buffer:
            raise TextureDeliveryError("GLB contains an external buffer URI")
    for image in document.get("images", []):
        if "uri" in image:
            raise TextureDeliveryError("GLB contains an external image URI")
        if "bufferView" not in image:
            raise TextureDeliveryError("GLB image is not embedded")
    return document


def _load_glb_mesh_and_texture(path: Path):
    _glb_document(path)
    try:
        scene = trimesh.load(path, process=False, force="scene")
    except Exception as exc:
        raise TextureDeliveryError("GLB cannot be decoded") from exc
    instances = []
    for node_name in scene.graph.nodes_geometry:
        transform, geometry_name = scene.graph.get(node_name)
        instances.append((node_name, geometry_name, transform))
    if not instances:
        raise TextureDeliveryError("GLB has no triangle mesh")
    vertices = []
    faces = []
    uv_present = True
    images = []
    offset = 0
    for node_name, geometry_name, transform in instances:
        geometry = scene.geometry[geometry_name]
        verts = np.asarray(geometry.vertices)
        verts = trimesh.transform_points(verts, transform)
        tris = np.asarray(geometry.faces)
        if not hasattr(geometry.visual, "uv") or geometry.visual.uv is None:
            uv_present = False
        else:
            uv = np.asarray(geometry.visual.uv)
            if uv.shape != (len(verts), 2) or not np.isfinite(uv).all():
                uv_present = False
        material = getattr(geometry.visual, "material", None)
        image = getattr(material, "baseColorTexture", None) if material is not None else None
        if image is None and material is not None:
            image = getattr(material, "image", None)
        if isinstance(image, Image.Image):
            images.append(image.copy())
        vertices.append(verts)
        faces.append(tris + offset)
        offset += len(verts)
    if not uv_present:
        raise TextureDeliveryError("GLB mesh is missing valid UV coordinates")
    if len(images) != 1:
        raise TextureDeliveryError("GLB must contain exactly one decoded base-color texture")
    return np.concatenate(vertices), np.concatenate(faces), images[0]


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as exc:
        raise TextureDeliveryError(f"cannot read {path.name}") from exc
    if not isinstance(data, dict):
        raise TextureDeliveryError(f"{path.name} must be a JSON object")
    return data


def verify_uv_recipe(glb,report):
    recipe=report.get('uvNormalization')
    if recipe is None:return  # Historical file checks made no UV-quality claim.
    if (not isinstance(recipe,dict) or recipe.get('recipe')!='normalized-uv-working-copy-v1'
            or recipe.get('workingLongestEdge')!=2 or recipe.get('geometryPreservedAtFloat32') is not True):
        raise TextureDeliveryError('UV recipe is invalid')
    from texture_uv_scale import uv_quality_stats
    try:
        mesh=trimesh.load(glb,process=False,force='mesh')
        actual=uv_quality_stats(mesh.faces,mesh.visual.uv)
    except Exception as exc:raise TextureDeliveryError('UV output is invalid or collapsed') from exc
    if report.get('outputUvStatistics')!=actual:raise TextureDeliveryError('UV statistics disagree with actual GLB')


def verify_delivery(jobs_root, job_id, attempt_id, source_path, reference_path, output_dir,
                    source_sha256, reference_sha256, profile):
    """Independently verify source, result reports, GLB geometry and texture."""
    if profile not in PROFILES:
        raise TextureDeliveryError("unknown profile")
    paths = validate_job_paths(jobs_root, job_id, attempt_id, source_path, reference_path, output_dir)
    source, reference, output = paths["source"], paths["reference"], paths["output"]
    for label, expected in (("source", source_sha256), ("reference", reference_sha256)):
        if not isinstance(expected, str) or not SHA256.fullmatch(expected):
            raise TextureDeliveryError(f"{label} hash must be lowercase SHA-256")
    actual_source, actual_reference = digest_file(source), digest_file(reference)
    if actual_source != source_sha256 or actual_reference != reference_sha256:
        raise TextureDeliveryError("source or reference hash mismatch")
    if source.stat().st_size > 25 * 1024 * 1024:
        raise TextureDeliveryError("source exceeds 25 MiB")
    if reference.stat().st_size > 5 * 1024 * 1024:
        raise TextureDeliveryError("reference exceeds 5 MiB")
    try:
        with Image.open(reference) as image:
            if image.width * image.height > 12_000_000:
                raise TextureDeliveryError("reference exceeds pixel limit")
            image.verify()
    except TextureDeliveryError:
        raise
    except Exception as exc:
        raise TextureDeliveryError("reference image cannot be decoded") from exc

    mesh = load_source_mesh(source)
    expected_mesh = transform_mesh_yup_metres(mesh)
    expected_signature = geometry_signature(expected_mesh.vertices, expected_mesh.faces)
    glb, probe = output / "textured.glb", output / "texture-probe.json"
    prepared_path = output / "source-yup-metres.glb"
    if not glb.is_file() or not probe.is_file() or not prepared_path.is_file():
        raise TextureDeliveryError("generated GLB, prepared source or probe evidence is missing")
    result_path = output / "result.json"
    for artifact in (glb, probe, prepared_path, result_path):
        _check_chain_no_links(artifact, paths["jobRoot"])
        try:
            if artifact.stat().st_nlink > 1:
                raise TextureDeliveryError("output artifact must not be a hard link")
        except OSError as exc:
            raise TextureDeliveryError("cannot inspect output artifact") from exc
    prepared_mesh = load_source_mesh(prepared_path)
    if geometry_signature(prepared_mesh.vertices, prepared_mesh.faces) != expected_signature:
        raise TextureDeliveryError("prepared source geometry or coordinate frame differs from requested transform")
    actual_glb_sha = digest_file(glb)
    glb_bytes = glb.stat().st_size
    verts, faces, texture = _load_glb_mesh_and_texture(glb)
    actual_signature = geometry_signature(verts, faces)
    if actual_signature != expected_signature:
        raise TextureDeliveryError("output geometry differs from transformed source (including winding/frame)")
    if len(faces) != len(mesh.faces):
        raise TextureDeliveryError("output face count differs from source")
    target_size = PROFILES[profile]["textureSize"]
    if texture.size != (target_size, target_size):
        raise TextureDeliveryError("decoded texture dimensions do not match profile")

    report = _read_json(probe)
    verify_uv_recipe(glb,report)
    required_report = {
        "status": "generated-awaiting-visual-review",
        "inputMeshSha256": digest_file(prepared_path),
        "inputImageSha256": reference_sha256,
        "sourceStlSha256": source_sha256,
        "referenceImageSha256": reference_sha256,
        "requestedProfile": profile,
        "expectedCoordinateTransform": TRANSFORM,
        "runId": f"texture-{job_id}-{attempt_id}",
        "outputGlbSha256": actual_glb_sha,
        "outputGlbBytes": glb_bytes,
        "inputGeometrySignature": expected_signature,
        "outputGeometrySignature": actual_signature,
        "inputFaces": len(mesh.faces),
        "outputFaces": len(faces),
        "geometryPreservedAtFloat32": True,
        "textureSizePixels": [target_size, target_size],
        "sourceRevision": PINNED_SOURCE_REVISION,
        "sourceRevisionExpected": PINNED_SOURCE_REVISION,
        "sourceGitTreeExpected": PINNED_SOURCE_TREE,
        "modelRevision": MODEL_REVISION,
    }
    for key, value in required_report.items():
        if report.get(key) != value:
            raise TextureDeliveryError(f"probe report field mismatch: {key}")
    options = report.get("options")
    expected_profile = PROFILES[profile]
    if (not isinstance(options, dict)
            or options.get("render_size") != expected_profile["renderSize"]
            or options.get("texture_size") != expected_profile["textureSize"]
            or options.get("generatedViews") != expected_profile["views"]
            or options.get("referenceViews") != 1
            or options.get("weightOffload") != "model"
            or options.get("paintOuterRequestedSteps") != 30
            or options.get("delightStepsPerReference") != 0
            or options.get("delighting") != "skipped explicitly for flat illustration"):
        raise TextureDeliveryError("probe profile configuration does not match the fixed profile")
    source_proof = report.get("sourceVerification")
    if not isinstance(source_proof, dict) or source_proof.get("revision") != PINNED_SOURCE_REVISION or source_proof.get("gitTree") != PINNED_SOURCE_TREE:
        raise TextureDeliveryError("pinned source verification evidence is missing or invalid")
    result = _read_json(output / "result.json")
    expected_result = {
        "success": True, "code": "OK", "attemptId": attempt_id, "profile": profile,
        "sourceSha256": source_sha256, "referenceSha256": reference_sha256,
        "glbSha256": actual_glb_sha, "glbBytes": glb_bytes,
        "proof": {"inputGeometrySignature": expected_signature,
                  "outputGeometrySignature": actual_signature,
                  "coordinateTransform": TRANSFORM,
                  "modelRevision": MODEL_REVISION,
                  "sourceRevision": PINNED_SOURCE_REVISION},
    }
    for key, value in expected_result.items():
        if result.get(key) != value:
            raise TextureDeliveryError(f"worker result field mismatch: {key}")
    metrics = result.get("metrics")
    if (not isinstance(metrics, dict) or metrics.get("faces") != len(faces)
            or metrics.get("textureSizePixels") != [target_size, target_size]
            or metrics.get("geometryPreservedAtFloat32") is not True
            or metrics.get("peakAllocatedGpuMiB") != report.get("peakAllocatedGpuMiB")
            or metrics.get("elapsedSeconds") != report.get("elapsedSeconds")):
        raise TextureDeliveryError("worker result metrics are invalid")
    if (digest_file(source) != actual_source or digest_file(reference) != actual_reference
            or digest_file(glb) != actual_glb_sha or digest_file(prepared_path) != report["inputMeshSha256"]):
        raise TextureDeliveryError("source or output changed during independent verification")
    return {
        "glbSha256": actual_glb_sha, "glbBytes": glb_bytes,
        "metrics": metrics, "proof": expected_result["proof"],
    }
