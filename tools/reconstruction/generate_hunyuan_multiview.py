"""Offline shape-only inference with the locally pinned Hunyuan3D-2mv checkpoint.

The CLI accepts only three local views and bounded generation settings. It does not
call a cloud API, load texture weights, invoke a shell, or submit an AGH task.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image
from gpu_reservation import reserve_gpu

from hunyuan_core import (
    BOUNDED_TRIANGLE_TARGET,
    MAX_IMPORT_BYTES,
    MODEL_REPO,
    MODEL_REVISION,
    MODEL_SHA256,
    MODEL_SIZE,
    MODEL_SUBFOLDER,
    compute_yup_to_zup_transform,
    requires_import_simplification,
    validate_run_options,
)


ROOT = Path(__file__).resolve().parents[2]
GENERATED_ROOT = ROOT / "data" / "reconstruction" / "generated"
MODEL_CACHE_ROOT = ROOT / "data" / "reconstruction" / "modelcache"
MODEL_ROOT = MODEL_CACHE_ROOT / "hunyuan3d-2mv"
WEIGHT_PATH = MODEL_ROOT / MODEL_SUBFOLDER / "model.fp16.safetensors"
CONFIG_PATH = MODEL_ROOT / MODEL_SUBFOLDER / "config.yaml"
MANIFEST_PATH = MODEL_ROOT / "download-manifest.json"
SOURCE_ROOT = ROOT / "data" / "reconstruction" / "source-f8db630" / "Hunyuan3D-2-f8db63096c8282cb27354314d896feba5ba6ff8a"
SOURCE_REVISION = "f8db63096c8282cb27354314d896feba5ba6ff8a"
CONFIG_GIT_BLOB_SHA1 = "7a9b1f3b1ca62e16a24257b8e8328573d299c5e4"
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_IMAGE_PIXELS = 12_000_000


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _git_blob_sha1(data: bytes) -> str:
    return hashlib.sha1(f"blob {len(data)}\0".encode("ascii") + data).hexdigest()


def verify_local_model() -> dict:
    if not SOURCE_ROOT.joinpath("hy3dgen", "shapegen", "pipelines.py").is_file():
        raise FileNotFoundError("pinned Hunyuan3D source snapshot is missing")
    if not WEIGHT_PATH.is_file() or not CONFIG_PATH.is_file() or not MANIFEST_PATH.is_file():
        raise FileNotFoundError("pinned local Hunyuan3D-2mv shape weights/config are missing")
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    expected = {
        "repo": MODEL_REPO,
        "revision": MODEL_REVISION,
        "path": f"{MODEL_SUBFOLDER}/model.fp16.safetensors",
        "size": MODEL_SIZE,
        "sha256": MODEL_SHA256,
    }
    if any(manifest.get(key) != value for key, value in expected.items()):
        raise ValueError("local weight manifest does not match the pinned official model")
    if WEIGHT_PATH.stat().st_size != MODEL_SIZE or sha256_file(WEIGHT_PATH) != MODEL_SHA256:
        raise ValueError("local shape weight failed the pinned size/SHA-256 check")
    if _git_blob_sha1(CONFIG_PATH.read_bytes()) != CONFIG_GIT_BLOB_SHA1:
        raise ValueError("local config does not match the pinned model revision")
    return {
        "repo": MODEL_REPO,
        "revision": MODEL_REVISION,
        "weightsSha256": MODEL_SHA256,
        "sourceRevision": SOURCE_REVISION,
    }


def read_view(path: Path) -> tuple[Image.Image, dict]:
    if not path.is_file():
        raise FileNotFoundError(f"view file does not exist: {path.name}")
    data = path.read_bytes()
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise ValueError(f"view {path.name} must be non-empty and no larger than 5 MiB")
    try:
        with Image.open(path) as source:
            if source.format not in {"PNG", "JPEG"}:
                raise ValueError(f"view {path.name} must be PNG or JPEG")
            if source.width * source.height > MAX_IMAGE_PIXELS:
                raise ValueError(f"view {path.name} exceeds 12 megapixels")
            image = source.convert("RGBA")
    except ValueError:
        raise
    except Exception as error:
        raise ValueError(f"view {path.name} could not be decoded") from error
    return image, {
        "fileName": path.name,
        "sha256": hashlib.sha256(data).hexdigest(),
        "bytes": len(data),
        "sizePx": list(image.size),
    }


def prepare_view_inputs(args):
    side = getattr(args, "side_view", "left")
    if side not in ("left", "right"):
        raise ValueError("side view must be left or right")
    inputs, metadata = {}, {}
    for slot in ("front", "left", "back"):
        image, info = read_view(getattr(args, slot))
        tag = side if slot == "left" else slot
        inputs[tag] = image
        metadata[slot] = {**info, "viewTag": tag}
    return inputs, metadata


def simplify_for_import(full_stl: Path, bounded_stl: Path) -> dict:
    import pymeshlab
    import trimesh

    mesh_set = pymeshlab.MeshSet()
    mesh_set.load_new_mesh(str(full_stl))
    source_id = mesh_set.current_mesh_id()
    source_mesh = mesh_set.current_mesh()
    source_vertices = int(source_mesh.vertex_matrix().shape[0])
    source_faces = int(source_mesh.face_matrix().shape[0])
    mesh_set.generate_copy_of_current_mesh()
    reduced_id = mesh_set.current_mesh_id()
    started = time.perf_counter()
    mesh_set.meshing_decimation_quadric_edge_collapse(
        targetfacenum=BOUNDED_TRIANGLE_TARGET,
        targetperc=0.0,
        qualitythr=0.3,
        preserveboundary=True,
        boundaryweight=1.0,
        preservenormal=True,
        preservetopology=True,
        optimalplacement=True,
        planarquadric=False,
        planarweight=0.001,
        qualityweight=False,
        autoclean=True,
        selected=False,
    )
    duration = time.perf_counter() - started
    reduced_mesh = mesh_set.current_mesh()
    reduced_vertices = int(reduced_mesh.vertex_matrix().shape[0])
    reduced_faces = int(reduced_mesh.face_matrix().shape[0])
    source_to_reduced = mesh_set.get_hausdorff_distance(
        sampledmesh=source_id,
        targetmesh=reduced_id,
        samplevert=True,
        sampleedge=False,
        samplefauxedge=False,
        sampleface=False,
        samplenum=source_vertices,
    )
    reduced_to_source = mesh_set.get_hausdorff_distance(
        sampledmesh=reduced_id,
        targetmesh=source_id,
        samplevert=True,
        sampleedge=False,
        samplefauxedge=False,
        sampleface=False,
        samplenum=reduced_vertices,
    )
    bounded_mesh = trimesh.Trimesh(
        vertices=reduced_mesh.vertex_matrix(), faces=reduced_mesh.face_matrix(), process=False
    )
    bounded_mesh.export(bounded_stl)
    if reduced_faces > BOUNDED_TRIANGLE_TARGET or bounded_stl.stat().st_size > MAX_IMPORT_BYTES:
        raise ValueError("bounded STL still exceeds the model-import triangle/byte limit")
    if not bounded_mesh.is_watertight or not bounded_mesh.is_winding_consistent:
        raise ValueError("topology-preserving simplifier returned an open/inconsistent mesh")
    return {
        "algorithm": "PyMeshLab quadric edge-collapse",
        "targetFaces": BOUNDED_TRIANGLE_TARGET,
        "sourceFaces": source_faces,
        "sourceVertices": source_vertices,
        "faces": reduced_faces,
        "vertices": reduced_vertices,
        "durationSeconds": round(duration, 3),
        "settings": {"preserveBoundary": True, "preserveTopology": True, "preserveNormal": True, "optimalPlacement": True, "qualityThreshold": 0.3},
        "errorMetric": {
            "kind": "bidirectional vertex-sampled surface distance; not a continuous Hausdorff bound",
            "sourceVerticesToSimplifiedSurfaceMm": source_to_reduced,
            "simplifiedVerticesToSourceSurfaceMm": reduced_to_source,
            "maxOfSampledDirectedMaxMm": max(source_to_reduced["max"], reduced_to_source["max"]),
        },
        "watertight": bool(bounded_mesh.is_watertight),
        "windingConsistent": bool(bounded_mesh.is_winding_consistent),
        "stlBytes": bounded_stl.stat().st_size,
        "sha256": sha256_file(bounded_stl),
    }


def run(args) -> Path:
    options = validate_run_options(
        steps=args.steps,
        resolution=args.resolution,
        num_chunks=args.num_chunks,
        seed=args.seed,
        target_longest_edge_mm=args.target_longest_edge_mm,
        run_id=args.run_id,
    )
    provenance = verify_local_model()
    inputs, input_metadata = prepare_view_inputs(args)

    output_dir = GENERATED_ROOT / options["runId"]
    if output_dir.exists():
        raise FileExistsError(f"run output already exists: {output_dir}")
    input_dir = output_dir / "input_views"
    input_dir.mkdir(parents=True, exist_ok=False)
    for name, image in inputs.items():
        image.save(input_dir / f"{name}.png", format="PNG")

    os.environ.setdefault("USE_SAGEATTN", "0")
    sys.path.insert(0, str(SOURCE_ROOT))
    import torch
    from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable in this isolated environment")
    device_name = torch.cuda.get_device_name(0)
    compute_capability = list(torch.cuda.get_device_capability(0))
    load_started = time.perf_counter()
    pipeline = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
        str(MODEL_ROOT),
        subfolder=MODEL_SUBFOLDER,
        variant="fp16",
        use_safetensors=True,
        device="cuda",
    )
    torch.cuda.synchronize()
    load_seconds = time.perf_counter() - load_started
    torch.cuda.reset_peak_memory_stats()

    generation_started = time.perf_counter()
    mesh = pipeline(
        image=inputs,
        num_inference_steps=options["numInferenceSteps"],
        octree_resolution=options["octreeResolution"],
        num_chunks=options["numChunks"],
        generator=torch.manual_seed(options["seed"]),
        output_type="trimesh",
        mc_algo="mc",
    )[0]
    torch.cuda.synchronize()
    generation_seconds = time.perf_counter() - generation_started
    peak_gpu_memory_mib = round(torch.cuda.max_memory_allocated() / (1024**2), 1)

    raw_glb = output_dir / "raw-y-up.glb"
    mesh.export(raw_glb)
    transform, transform_metadata = compute_yup_to_zup_transform(
        mesh.vertices, options["targetLongestEdgeMm"]
    )
    print_ready = mesh.copy()
    print_ready.apply_transform(transform)
    full_stl = output_dir / "print-ready-z-up-full.stl"
    print_ready.export(full_stl)
    full_triangles = int(len(print_ready.faces))
    import_ready_stl = full_stl
    simplification = None
    if requires_import_simplification(full_triangles, full_stl.stat().st_size):
        bounded_stl = output_dir / f"print-ready-z-up-{BOUNDED_TRIANGLE_TARGET}-faces.stl"
        simplification = simplify_for_import(full_stl, bounded_stl)
        import_ready_stl = bounded_stl

    report = {
        "model": provenance,
        "engine": "Tencent Hunyuan3D-2mv shape-only; no texture model loaded",
        "inputViews": input_metadata,
        "sideView": getattr(args, "side_view", "left"),
        "settings": {**options, "device": device_name, "computeCapability": compute_capability, "dtype": "fp16", "surfaceExtractor": "skimage marching cubes"},
        "runtime": {"torch": torch.__version__, "cuda": torch.version.cuda, "loadSeconds": round(load_seconds, 3), "generationSeconds": round(generation_seconds, 3), "peakGpuMemoryMiB": peak_gpu_memory_mib},
        "rawMesh": {"path": raw_glb.name, "sha256": sha256_file(raw_glb), "bytes": raw_glb.stat().st_size, "vertices": int(len(mesh.vertices)), "faces": full_triangles, "boundsYUp": mesh.bounds.tolist(), "extentsYUp": mesh.extents.tolist(), "watertight": bool(mesh.is_watertight), "windingConsistent": bool(mesh.is_winding_consistent), "volumeNormalized": float(mesh.volume)},
        "transformToPrintCoordinates": transform_metadata,
        "fullPrintMesh": {"path": full_stl.name, "bytes": full_stl.stat().st_size, "sha256": sha256_file(full_stl), "faces": full_triangles, "boundsMm": print_ready.bounds.tolist(), "extentsMm": print_ready.extents.tolist(), "watertight": bool(print_ready.is_watertight), "windingConsistent": bool(print_ready.is_winding_consistent)},
        "importReadyStl": import_ready_stl.name,
        "simplification": simplification,
        "validationScope": {"kind": "generated-geometry-only", "notEvaluated": ["mechanical strength", "slicing", "printer profile", "physical print"]},
        "limitations": ["three views may not be calibrated orthographic photos", "the longest-edge scale is user-selected, not inferred from the sheet", "no textures were generated", "mesh checks do not establish printability"],
    }
    report_path = output_dir / "generation.json"
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return output_dir


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--front", type=Path, required=True)
    parser.add_argument("--left", "--side", dest="left", type=Path, required=True)
    parser.add_argument("--side-view", choices=("left", "right"), default="left")
    parser.add_argument("--back", type=Path, required=True)
    parser.add_argument("--target-longest-edge-mm", type=float, required=True)
    parser.add_argument("--steps", type=int, default=25)
    parser.add_argument("--resolution", type=int, choices=(128, 256, 384), default=128)
    parser.add_argument("--num-chunks", type=int, choices=(4000, 8000, 20000), default=8000)
    parser.add_argument("--seed", type=int, default=12345)
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("multiview-%Y%m%d-%H%M%S"))
    args = parser.parse_args()
    try:
        with reserve_gpu(ROOT, args.run_id):
            output = run(args)
    except (OSError, ValueError, RuntimeError) as error:
        parser.error(str(error))
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
