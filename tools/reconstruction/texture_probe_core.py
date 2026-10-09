"""Small CPU-only guards for deterministic texture experiments.

These helpers prove source-mesh geometry invariance and constrain experiment
inputs. They do not implement a texture pipeline or establish visual fidelity.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any

import numpy as np


MAX_FACES = 250_000
MAX_MESH_BYTES = 25 * 1024 * 1024
RENDER_SIZES = frozenset((512, 1024))
TEXTURE_SIZES = frozenset((512, 1024, 2048))
MAX_BUDGET_STEPS = 30
SAFE_RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def _lexicographically_less(left: np.ndarray, right: np.ndarray) -> np.ndarray:
    """Return row-wise lexicographic comparison for two finite float arrays."""
    different = left != right
    has_difference = np.any(different, axis=1)
    first = np.argmax(different, axis=1)
    rows = np.arange(len(left))
    return has_difference & (left[rows, first] < right[rows, first])


def geometry_signature(vertices: Any, faces: Any) -> str:
    """Hash the oriented triangle-coordinate multiset, independent of indices.

    Positions are normalized to little-endian float32, matching the position
    precision used by GLB. Each oriented face is canonicalized only across its
    three cyclic rotations; reversed winding remains a different signature.
    """
    raw_vertices = np.asarray(vertices)
    if raw_vertices.ndim != 2 or raw_vertices.shape[1] != 3 or raw_vertices.shape[0] == 0:
        raise ValueError("vertices must be a non-empty Nx3 array")
    if not np.issubdtype(raw_vertices.dtype, np.number) or np.issubdtype(raw_vertices.dtype, np.complexfloating):
        raise ValueError("vertices must contain finite real coordinates")
    if not np.isfinite(raw_vertices).all():
        raise ValueError("vertices must contain finite real coordinates")
    with np.errstate(over="ignore", invalid="ignore"):
        vertices32 = np.asarray(raw_vertices, dtype=np.float32)
    if not np.isfinite(vertices32).all():
        raise ValueError("vertices are not representable as finite float32 coordinates")

    raw_faces = np.asarray(faces)
    if raw_faces.ndim != 2 or raw_faces.shape[1] != 3 or raw_faces.shape[0] == 0:
        raise ValueError("faces must be a non-empty Mx3 triangle index array")
    if not np.issubdtype(raw_faces.dtype, np.integer) or np.issubdtype(raw_faces.dtype, np.bool_):
        raise ValueError("face indices must be integers")
    if np.any(raw_faces < 0) or np.any(raw_faces >= len(vertices32)):
        raise ValueError("face indices are outside the vertex array")

    triangles = vertices32[raw_faces.astype(np.int64, copy=False)]
    rotations = (
        triangles.reshape((-1, 9)),
        triangles[:, [1, 2, 0], :].reshape((-1, 9)),
        triangles[:, [2, 0, 1], :].reshape((-1, 9)),
    )
    canonical = rotations[0].copy()
    for rotation in rotations[1:]:
        replace = _lexicographically_less(rotation, canonical)
        canonical[replace] = rotation[replace]

    # Treat +0 and -0 as the same coordinate while preserving all other
    # float32 distinctions. Face reversal is intentionally never normalized.
    canonical[canonical == 0] = 0.0
    sort_keys = tuple(canonical[:, column] for column in reversed(range(9)))
    ordered = canonical[np.lexsort(sort_keys)]
    canonical_bytes = np.asarray(ordered, dtype="<f4", order="C").tobytes()
    return hashlib.sha256(canonical_bytes).hexdigest()


def _bounded_integer(value: Any, name: str) -> int:
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, (int, np.integer)):
        raise ValueError(f"{name} must be an integer")
    value = int(value)
    if value < 0:
        raise ValueError(f"{name} must not be negative")
    return value


def validate_mesh_bounds(facecount: int, bytecount: int) -> dict[str, int]:
    """Validate an input mesh against the small-probe size envelope."""
    faces = _bounded_integer(facecount, "face count")
    size = _bounded_integer(bytecount, "byte count")
    if faces == 0:
        raise ValueError("face count must be positive")
    if size == 0:
        raise ValueError("byte count must be positive")
    if faces > MAX_FACES:
        raise ValueError(f"face count exceeds limit {MAX_FACES}")
    if size > MAX_MESH_BYTES:
        raise ValueError(f"byte count exceeds limit {MAX_MESH_BYTES}")
    return {"faces": faces, "bytes": size, "max_faces": MAX_FACES, "max_bytes": MAX_MESH_BYTES}


def validate_texture_options(
    render_size: int, texture_size: int, run_id: str, budget_steps: int
) -> dict[str, int | str]:
    """Validate bounded experiment options without starting any rendering."""
    render = _bounded_integer(render_size, "render size")
    texture = _bounded_integer(texture_size, "texture size")
    steps = _bounded_integer(budget_steps, "budget steps")
    if render not in RENDER_SIZES:
        raise ValueError(f"render size must be one of {sorted(RENDER_SIZES)}")
    if texture not in TEXTURE_SIZES:
        raise ValueError(f"texture size must be one of {sorted(TEXTURE_SIZES)}")
    if not isinstance(run_id, str) or not SAFE_RUN_ID.fullmatch(run_id):
        raise ValueError("run_id must be a safe 1-64 character identifier")
    if not 1 <= steps <= MAX_BUDGET_STEPS:
        raise ValueError(f"budget steps must be in [1, {MAX_BUDGET_STEPS}]")
    return {"render_size": render, "texture_size": texture, "run_id": run_id, "budget_steps": steps}


def ensure_new_output_directory(path: str | Path) -> Path:
    """Create a fresh output directory, refusing to overwrite any existing path."""
    output = Path(path)
    if output.exists():
        raise ValueError(f"output directory already exists: {output}")
    try:
        output.mkdir(parents=True, exist_ok=False)
    except FileExistsError as exc:
        raise ValueError(f"output directory already exists: {output}") from exc
    return output


def _load_checkpoint_on_meta(factory, checkpoint_loader, dtype=None):
    """Shared strict meta construction and state assignment for local weights."""
    try:
        import torch
    except ImportError as exc:
        raise RuntimeError("checkpoint loading requires installed torch") from exc
    if not callable(factory):
        raise ValueError("factory must be callable")
    target_dtype = torch.float16 if dtype is None else dtype
    if not isinstance(target_dtype, torch.dtype) or not torch.empty((), dtype=target_dtype).is_floating_point():
        raise ValueError("dtype must be a floating-point torch dtype")

    with torch.device("meta"):
        module = factory()
    if not isinstance(module, torch.nn.Module):
        raise ValueError("factory must return a torch.nn.Module")
    for name, parameter in module.named_parameters():
        if not parameter.is_meta:
            raise RuntimeError(f"factory allocated parameter outside meta device: {name}")
    for name, buffer in module.named_buffers():
        if not buffer.is_meta:
            raise RuntimeError(f"factory allocated buffer outside meta device: {name}")

    expected = module.state_dict()
    checkpoint = checkpoint_loader(torch)
    if not isinstance(checkpoint, dict):
        raise ValueError("checkpoint must contain a state-dict mapping")
    if not all(isinstance(key, str) for key in checkpoint):
        raise ValueError("checkpoint state keys must be strings")
    expected_keys, checkpoint_keys = set(expected), set(checkpoint)
    if expected_keys != checkpoint_keys:
        missing = sorted(expected_keys - checkpoint_keys)
        unknown = sorted(checkpoint_keys - expected_keys)
        raise ValueError(f"checkpoint state key mismatch; missing={missing}, unknown={unknown}")

    prepared = {}
    for key, target in expected.items():
        source = checkpoint[key]
        if not isinstance(source, torch.Tensor):
            raise ValueError(f"checkpoint entry is not a tensor: {key}")
        if tuple(source.shape) != tuple(target.shape):
            raise ValueError(f"checkpoint shape mismatch for {key}: expected {tuple(target.shape)}, got {tuple(source.shape)}")
        if source.is_floating_point():
            prepared[key] = source if source.dtype == target_dtype else source.to(dtype=target_dtype)
        else:
            if source.dtype != target.dtype:
                raise ValueError(f"checkpoint non-floating dtype mismatch for {key}: expected {target.dtype}, got {source.dtype}")
            prepared[key] = source

    try:
        incompatible = module.load_state_dict(prepared, strict=True, assign=True)
    except Exception as exc:
        raise RuntimeError(f"strict checkpoint assignment failed: {exc}") from exc
    if incompatible.missing_keys or incompatible.unexpected_keys:
        raise ValueError(
            f"strict checkpoint assignment reported incompatible keys; "
            f"missing={incompatible.missing_keys}, unknown={incompatible.unexpected_keys}"
        )
    for name, parameter in module.named_parameters():
        if parameter.is_meta:
            raise RuntimeError(f"meta parameter remains after checkpoint assignment: {name}")
    for name, buffer in module.named_buffers():
        if buffer.is_meta:
            raise RuntimeError(f"meta buffer remains after checkpoint assignment: {name}")
    return module


def load_safetensors_on_meta(factory, checkpoint_path: str | Path, dtype=None):
    """Create a module on meta and strictly assign CPU safetensors weights.

    Torch and safetensors are imported only when this helper is called. The
    safetensors CPU loader uses memory-mapped file access; matching-dtype tensors
    are assigned directly, while floating tensors are cast only when needed.
    """
    try:
        from safetensors.torch import load_file
    except ImportError as exc:
        raise RuntimeError("loading a safetensors checkpoint requires safetensors") from exc
    path = str(checkpoint_path)
    return _load_checkpoint_on_meta(factory, lambda _torch: load_file(path, device="cpu"), dtype)


def load_torch_checkpoint_on_meta(factory, checkpoint_path: str | Path, dtype=None):
    """Load a local torch.save ZIP checkpoint via CPU mmap and strict meta assign.

    ``weights_only=True`` excludes general pickle object loading. This accepts a
    plain state dict only and shares all key/shape/dtype/meta checks with the
    safetensors helper.
    """
    path = str(checkpoint_path)
    return _load_checkpoint_on_meta(
        factory,
        lambda torch: torch.load(path, map_location="cpu", weights_only=True, mmap=True),
        dtype,
    )
