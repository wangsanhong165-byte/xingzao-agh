#!/usr/bin/env python3
"""Inspect a bounded STL/GLB byte file and write a scaled diagnostic STL.

This module never executes source files and never resolves a model path from uploaded content.
GLB is parsed from BytesIO only after all external URIs are rejected.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import math
import os
import re
import struct
import sys
from pathlib import Path
from typing import Any

import numpy as np
import trimesh


MAX_BYTES = 25 * 1024 * 1024
MAX_TRIANGLES = 250_000
MAX_PARTS = 128
MAX_JSON_NODES = 100_000
MAX_GLTF_DEPTH = 64
MAX_DATA_URI_CHARS = MAX_BYTES * 4 // 3 + 16
HEX_SHA256 = re.compile(r"^[a-f0-9]{64}$")


class ImportFailure(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def fail(code: str) -> None:
    raise ImportFailure(code)


def exact_job_paths(input_arg: str, summary_arg: str, stl_arg: str, candidate_id: str):
    if not HEX_SHA256.fullmatch(candidate_id):
        fail("IMPORT_CANDIDATE_INVALID")
    root = Path(__file__).resolve().parents[2]
    data_root = root / "data"
    import_root = root / "data" / "import-jobs"
    expected_dir = import_root / candidate_id
    raw_input = Path(input_arg)
    raw_summary = Path(summary_arg)
    raw_stl = Path(stl_arg)
    if (
        not raw_input.is_absolute()
        or not raw_summary.is_absolute()
        or not raw_stl.is_absolute()
        or data_root.is_symlink()
        or import_root.is_symlink()
        or expected_dir.is_symlink()
        or raw_input.is_symlink()
        or raw_summary.is_symlink()
        or raw_stl.is_symlink()
    ):
        fail("IMPORT_PATH_INVALID")
    try:
        input_path = Path(input_arg).resolve(strict=True)
        summary_path = Path(summary_arg).resolve(strict=False)
        stl_path = Path(stl_arg).resolve(strict=False)
        job_dir = expected_dir.resolve(strict=True)
        expected_root = import_root.resolve(strict=True)
    except OSError:
        fail("IMPORT_PATH_INVALID")
    if (
        input_path.is_symlink()
        or job_dir.parent != expected_root
        or input_path.parent != job_dir
        or input_path.name not in {"input.stl", "input.glb"}
        or summary_path.parent != job_dir
        or summary_path.name != "summary.json"
        or stl_path.parent != job_dir
        or stl_path.name != "normalized.stl"
    ):
        fail("IMPORT_PATH_INVALID")
    return input_path, summary_path, stl_path, job_dir


def validate_data_uri(uri: str) -> None:
    if len(uri) > MAX_DATA_URI_CHARS + 128:
        fail("IMPORT_GLB_DATA_URI_LIMIT")
    header, comma, payload = uri.partition(",")
    if not comma or not header.startswith("data:") or not header.endswith(";base64"):
        fail("IMPORT_GLB_DATA_URI_INVALID")
    media_type = header[5:-7].lower()
    allowed = {
        "application/octet-stream",
        "application/gltf-buffer",
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/avif",
        "image/ktx2",
    }
    if media_type not in allowed:
        fail("IMPORT_GLB_DATA_URI_INVALID")
    if len(payload) > MAX_DATA_URI_CHARS or len(payload) % 4 == 1:
        fail("IMPORT_GLB_DATA_URI_LIMIT")
    if not re.fullmatch(r"[A-Za-z0-9+/]*={0,2}", payload):
        fail("IMPORT_GLB_DATA_URI_INVALID")
    try:
        decoded = base64.b64decode(payload, validate=True)
    except (ValueError, base64.binascii.Error):
        fail("IMPORT_GLB_DATA_URI_INVALID")
    if base64.b64encode(decoded).decode("ascii").rstrip("=") != payload.rstrip("="):
        fail("IMPORT_GLB_DATA_URI_INVALID")


def inspect_glb_json(data: bytes) -> dict[str, Any]:
    if len(data) < 20 or data[:4] != b"glTF":
        fail("IMPORT_GLB_INVALID")
    version, total_length = struct.unpack_from("<II", data, 4)
    if version != 2 or total_length != len(data):
        fail("IMPORT_GLB_INVALID")

    offset = 12
    json_chunk: bytes | None = None
    chunk_index = 0
    while offset < len(data):
        if offset + 8 > len(data):
            fail("IMPORT_GLB_INVALID")
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        end = offset + chunk_length
        if chunk_length == 0 or end > len(data) or chunk_length % 4 != 0:
            fail("IMPORT_GLB_INVALID")
        if chunk_index == 0 and chunk_type == 0x4E4F534A:
            try:
                json_chunk = data[offset:end].decode("utf-8", errors="strict").rstrip("\x00 \t\r\n").encode()
            except UnicodeDecodeError:
                fail("IMPORT_GLB_INVALID")
        elif chunk_index == 1 and chunk_type == 0x004E4942:
            pass
        else:
            fail("IMPORT_GLB_CHUNK_UNSUPPORTED")
        chunk_index += 1
        offset = end
    if json_chunk is None or chunk_index > 2 or offset != len(data):
        fail("IMPORT_GLB_INVALID")
    try:
        gltf = json.loads(json_chunk)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("IMPORT_GLB_INVALID")
    if not isinstance(gltf, dict) or gltf.get("asset", {}).get("version") != "2.0":
        fail("IMPORT_GLB_INVALID")

    stack: list[tuple[Any, int]] = [(gltf, 0)]
    node_count = 0
    while stack:
        value, depth = stack.pop()
        node_count += 1
        if node_count > MAX_JSON_NODES or depth > MAX_GLTF_DEPTH:
            fail("IMPORT_GLB_JSON_LIMIT")
        if isinstance(value, dict):
            for key, child in value.items():
                if key == "uri":
                    if not isinstance(child, str):
                        fail("IMPORT_GLB_URI_INVALID")
                    if child.startswith("data:"):
                        validate_data_uri(child)
                    else:
                        fail("IMPORT_GLB_EXTERNAL_URI")
                stack.append((child, depth + 1))
        elif isinstance(value, list):
            stack.extend((child, depth + 1) for child in value)

    estimate_gltf_complexity(gltf)
    return gltf


def estimate_gltf_complexity(gltf: dict[str, Any]) -> None:
    meshes = gltf.get("meshes", [])
    nodes = gltf.get("nodes", [])
    if not isinstance(meshes, list) or not isinstance(nodes, list):
        fail("IMPORT_GLB_INVALID")
    if len(meshes) > MAX_PARTS or len(nodes) > MAX_JSON_NODES:
        fail("IMPORT_PART_LIMIT")

    triangle_counts: list[int] = []
    primitive_counts: list[int] = []
    accessors = gltf.get("accessors", [])
    if not isinstance(accessors, list):
        fail("IMPORT_GLB_INVALID")
    for mesh in meshes:
        primitives = mesh.get("primitives", []) if isinstance(mesh, dict) else []
        if not isinstance(primitives, list) or not primitives:
            fail("IMPORT_GLB_INVALID")
        total = 0
        for primitive in primitives:
            if not isinstance(primitive, dict) or primitive.get("mode", 4) != 4:
                fail("IMPORT_GLB_PRIMITIVE_UNSUPPORTED")
            extensions = primitive.get("extensions", {})
            if isinstance(extensions, dict) and "KHR_draco_mesh_compression" in extensions:
                fail("IMPORT_GLB_PRIMITIVE_UNSUPPORTED")
            index = primitive.get("indices")
            if index is None:
                position_index = primitive.get("attributes", {}).get("POSITION")
                count = accessor_count(accessors, position_index)
                if count % 3 != 0:
                    fail("IMPORT_GLB_INVALID")
                total += count // 3
            else:
                count = accessor_count(accessors, index)
                if count % 3 != 0:
                    fail("IMPORT_GLB_INVALID")
                total += count // 3
        triangle_counts.append(total)
        primitive_counts.append(len(primitives))

    mesh_refs: list[int] = []
    if nodes:
        # All declared nodes are conservatively counted; unused mesh declarations may therefore
        # be rejected at the safety limit, but can never evade the bound through a scene selector.
        for node in nodes:
            if not isinstance(node, dict):
                fail("IMPORT_GLB_INVALID")
            if "mesh" in node:
                mesh_index = node["mesh"]
                if not isinstance(mesh_index, int) or mesh_index < 0 or mesh_index >= len(meshes):
                    fail("IMPORT_GLB_INVALID")
                mesh_refs.append(mesh_index)
            extensions = node.get("extensions", {})
            if isinstance(extensions, dict) and "EXT_mesh_gpu_instancing" in extensions:
                fail("IMPORT_GLB_INSTANCING_UNSUPPORTED")
    else:
        mesh_refs.extend(range(len(meshes)))
    triangle_count = sum(triangle_counts[index] for index in mesh_refs)
    part_count = sum(primitive_counts[index] for index in mesh_refs)
    if triangle_count > MAX_TRIANGLES:
        fail("IMPORT_TRIANGLE_LIMIT")
    if part_count > MAX_PARTS:
        fail("IMPORT_PART_LIMIT")


def accessor_count(accessors: list[Any], index: Any) -> int:
    if not isinstance(index, int) or index < 0 or index >= len(accessors):
        fail("IMPORT_GLB_INVALID")
    item = accessors[index]
    count = item.get("count") if isinstance(item, dict) else None
    if not isinstance(count, int) or count < 0:
        fail("IMPORT_GLB_INVALID")
    return count


def preflight_stl(data: bytes) -> int:
    if len(data) < 15:
        fail("IMPORT_STL_INVALID")
    if len(data) >= 84:
        declared = struct.unpack_from("<I", data, 80)[0]
        if declared > MAX_TRIANGLES:
            fail("IMPORT_TRIANGLE_LIMIT")
        expected = 84 + declared * 50
        if expected == len(data):
            if declared == 0:
                fail("IMPORT_STL_EMPTY")
            return declared
    try:
        text = data.decode("ascii")
    except UnicodeDecodeError:
        fail("IMPORT_STL_INVALID")
    if not text.lstrip().lower().startswith("solid"):
        fail("IMPORT_STL_INVALID")
    triangles = len(re.findall(r"\bfacet\s+normal\b", text, flags=re.IGNORECASE))
    if triangles == 0:
        fail("IMPORT_STL_EMPTY")
    if triangles > MAX_TRIANGLES:
        fail("IMPORT_TRIANGLE_LIMIT")
    if not re.search(r"\bendsolid\b", text, flags=re.IGNORECASE):
        fail("IMPORT_STL_INVALID")
    return triangles


def component_summary(mesh: trimesh.Trimesh) -> dict[str, Any]:
    bounds = np.asarray(mesh.bounds, dtype=np.float64)
    return {
        "triangleCount": int(len(mesh.faces)),
        "sourceBounds": {"min": bounds[0].tolist(), "max": bounds[1].tolist()},
        "watertight": bool(mesh.is_watertight),
        "windingConsistent": bool(mesh.is_winding_consistent),
    }


def edge_counts(mesh: trimesh.Trimesh) -> tuple[int, int]:
    if len(mesh.faces) == 0:
        return 0, 0
    inverse = np.asarray(mesh.edges_unique_inverse, dtype=np.int64)
    counts = np.bincount(inverse, minlength=len(mesh.edges_unique))
    return int(np.count_nonzero(counts == 1)), int(np.count_nonzero(counts > 2))


def atomic_write(path: Path, data: bytes) -> None:
    temporary = path.with_name(path.name + ".tmp")
    try:
        temporary.write_bytes(data)
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def inspect_mesh(
    input_path: Path,
    summary_path: Path,
    stl_path: Path,
    candidate_id: str,
    input_sha256: str,
    file_format: str,
    source_units: str,
    target_longest_edge_mm: float,
) -> dict[str, Any]:
    if file_format not in {"stl", "glb"} or source_units not in {"mm", "target-scale"}:
        fail("IMPORT_ARGUMENT_INVALID")
    if not math.isfinite(target_longest_edge_mm) or not 1 <= target_longest_edge_mm <= 180:
        fail("IMPORT_INVALID_SCALE")
    if not HEX_SHA256.fullmatch(input_sha256) or not HEX_SHA256.fullmatch(candidate_id):
        fail("IMPORT_HASH_INVALID")

    data = input_path.read_bytes()
    if len(data) == 0 or len(data) > MAX_BYTES:
        fail("IMPORT_BYTES_LIMIT")
    actual_sha = hashlib.sha256(data).hexdigest()
    if actual_sha != input_sha256:
        fail("IMPORT_INPUT_HASH_MISMATCH")
    if file_format == "stl":
        preflight_stl(data)
    else:
        inspect_glb_json(data)

    try:
        loaded = trimesh.load(
            io.BytesIO(data),
            file_type="stl" if file_format == "stl" else "glb",
            force="mesh" if file_format == "stl" else "scene",
            process=False,
        )
    except Exception:
        fail("IMPORT_MESH_PARSE_FAILED")

    if file_format == "stl" and isinstance(loaded, trimesh.Trimesh):
        # STL stores every face's vertices independently. Exact-coordinate welding restores the
        # connectivity implicit in STL without removing, filling, or otherwise repairing faces.
        try:
            loaded.merge_vertices(merge_tex=True, merge_norm=True, digits_vertex=None)
        except Exception:
            fail("IMPORT_STL_TOPOLOGY_FAILED")

    if isinstance(loaded, trimesh.Scene):
        try:
            parts = loaded.dump(concatenate=False)
        except Exception:
            fail("IMPORT_SCENE_TRANSFORM_FAILED")
    elif isinstance(loaded, trimesh.Trimesh):
        parts = [loaded]
    else:
        fail("IMPORT_NO_TRIANGLE_MESH")
    if not parts or len(parts) > MAX_PARTS:
        fail("IMPORT_PART_LIMIT" if parts else "IMPORT_NO_TRIANGLE_MESH")
    if any(not isinstance(part, trimesh.Trimesh) for part in parts):
        fail("IMPORT_NON_MESH_PRIMITIVE")

    per_parts: list[dict[str, Any]] = []
    total_triangles = 0
    for part in parts:
        vertices = np.asarray(part.vertices)
        faces = np.asarray(part.faces)
        if vertices.ndim != 2 or vertices.shape[1] != 3 or faces.ndim != 2 or faces.shape[1] != 3:
            fail("IMPORT_MESH_SHAPE_INVALID")
        if not np.isfinite(vertices).all():
            fail("IMPORT_NONFINITE_VERTEX")
        total_triangles += len(faces)
        if total_triangles > MAX_TRIANGLES:
            fail("IMPORT_TRIANGLE_LIMIT")
        per_parts.append(component_summary(part))

    try:
        combined = trimesh.util.concatenate(parts)
    except Exception:
        fail("IMPORT_MESH_COMBINE_FAILED")
    if not isinstance(combined, trimesh.Trimesh) or len(combined.faces) == 0:
        fail("IMPORT_NO_TRIANGLE_MESH")

    bounds = np.asarray(combined.bounds, dtype=np.float64)
    if bounds.shape != (2, 3) or not np.isfinite(bounds).all():
        fail("IMPORT_NONFINITE_BOUNDS")
    source_extents = bounds[1] - bounds[0]
    longest = float(np.max(source_extents))
    if not math.isfinite(longest) or longest <= 0:
        fail("IMPORT_ZERO_EXTENT")
    scale = float(target_longest_edge_mm / longest)
    source_bounds = {"min": bounds[0].tolist(), "max": bounds[1].tolist(), "units": source_units}

    # Match the print/slicer frame: center XY at (0, 0), place the transformed minimum Z at 0.
    # The matrix maps world-space source coordinates (after GLB node transforms) into normalized mm.
    center = (bounds[0] + bounds[1]) / 2.0
    translation = np.asarray([-center[0] * scale, -center[1] * scale, -bounds[0][2] * scale], dtype=np.float64)
    translation[np.abs(translation) < 1e-15] = 0.0
    normalization_transform = [
        [scale, 0.0, 0.0, float(translation[0])],
        [0.0, scale, 0.0, float(translation[1])],
        [0.0, 0.0, scale, float(translation[2])],
        [0.0, 0.0, 0.0, 1.0],
    ]
    # Preserve orientation and topology; never repair, remesh, or infer parts.
    normalized = combined.copy()
    normalized.apply_scale(scale)
    normalized.apply_translation(translation)
    normalized_bounds = np.asarray(normalized.bounds, dtype=np.float64)
    dimensions = normalized_bounds[1] - normalized_bounds[0]

    areas = np.asarray(normalized.area_faces, dtype=np.float64)
    degenerate = int(np.count_nonzero(~np.isfinite(areas) | (areas <= 1e-12)))
    watertight = bool(normalized.is_watertight)
    winding_consistent = bool(normalized.is_winding_consistent)
    boundary_edges, non_manifold_edges = edge_counts(normalized)
    signed_volume = float(normalized.volume) if watertight and winding_consistent and degenerate == 0 else None
    positive_volume = bool(signed_volume is not None and signed_volume > 0)
    volume_mm3 = abs(signed_volume) if signed_volume is not None else None
    printable = bool(
        watertight
        and winding_consistent
        and degenerate == 0
        and boundary_edges == 0
        and non_manifold_edges == 0
        and positive_volume
        and volume_mm3 is not None
    )

    try:
        exported = normalized.export(file_type="stl")
        if isinstance(exported, str):
            exported = exported.encode("ascii")
    except Exception:
        fail("IMPORT_STL_EXPORT_FAILED")
    if not isinstance(exported, bytes) or len(exported) == 0:
        fail("IMPORT_STL_EXPORT_FAILED")
    normalized_sha = hashlib.sha256(exported).hexdigest()

    result: dict[str, Any] = {
        "status": "inspected",
        "candidateId": candidate_id,
        "normalizationStrategy": "center-xy-z0-v1",
        "inputSha256": input_sha256,
        "inputBytes": len(data),
        "format": file_format,
        "sourceUnits": source_units,
        "targetLongestEdgeMm": float(target_longest_edge_mm),
        "scaleFactor": scale,
        "normalizationTransform": normalization_transform,
        "sourceBounds": source_bounds,
        "normalizedBoundsMm": {"min": normalized_bounds[0].tolist(), "max": normalized_bounds[1].tolist()},
        "dimensionsMm": {
            "x": float(dimensions[0]),
            "y": float(dimensions[1]),
            "z": float(dimensions[2]),
            "longestEdge": float(np.max(dimensions)),
        },
        "triangleCount": int(len(normalized.faces)),
        "partCount": len(parts),
        "parts": per_parts,
        "checks": {
            "watertight": watertight,
            "windingConsistent": winding_consistent,
            "degenerateFaceCount": degenerate,
            "boundaryEdgeCount": boundary_edges,
            "nonManifoldEdgeCount": non_manifold_edges,
            "positiveVolume": positive_volume,
            "volumeMm3": volume_mm3,
        },
        "geometryChecksPassed": printable,
        "printable": printable,
        "validationScope": {
            "kind": "geometry-only",
            "evaluated": [
                "watertightness", "winding-consistency", "degenerate-faces",
                "boundary-edges", "non-manifold-edges", "positive-volume",
            ],
            "notEvaluated": [
                "self-intersections", "slicing", "printer-profile", "mechanical-strength", "actual-print",
            ],
            "note": "printable is a legacy alias for geometryChecksPassed; it does not mean sliced or physically printable.",
        },
        "normalizedStlFile": "normalized.stl",
        "normalizedStlSha256": normalized_sha,
    }
    atomic_write(stl_path, exported)
    atomic_write(summary_path, (json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
    return result


def main() -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--normalized-stl", required=True)
    parser.add_argument("--candidate-id", required=True)
    parser.add_argument("--input-sha256", required=True)
    parser.add_argument("--format", choices=("stl", "glb"), required=True)
    parser.add_argument("--source-units", choices=("mm", "target-scale"), required=True)
    parser.add_argument("--target-longest-edge-mm", required=True, type=float)
    args = parser.parse_args()
    try:
        input_path, summary_path, stl_path, _ = exact_job_paths(
            args.input, args.summary, args.normalized_stl, args.candidate_id
        )
        inspect_mesh(
            input_path,
            summary_path,
            stl_path,
            args.candidate_id,
            args.input_sha256,
            args.format,
            args.source_units,
            args.target_longest_edge_mm,
        )
        return 0
    except ImportFailure as error:
        print(json.dumps({"code": error.code}), file=sys.stderr)
        return 2
    except Exception:
        print(json.dumps({"code": "IMPORT_INSPECTION_FAILED"}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
