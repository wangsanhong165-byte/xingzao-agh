# Reviewer preflight (2026-10-07)

Run from the repository root in PowerShell. The preflight is read-only: it does not download, install, start a server, call a model, reserve a GPU, or print credential values.

```powershell
node tools/review/preflight.mjs --mode offline
node tools/review/preflight.mjs --mode offline --json
```

`offline` returns exit code 0 when local mesh review and virtual slicing prerequisites are usable. It requires Node.js 24.10 or newer, the effective mesh Python runtime, `numpy`, `trimesh`, `rtree`, `manifold3d`, and the project's PrusaSlicer executable plus `fdm-pla-04.ini`. AGH credentials, Hunyuan weights, PyTorch, and a GPU are not prerequisites for this mode.

The mesh Python executable is selected from `PHOTO_CAD_MESH_PYTHON`, when set, or defaults to `data/reconstruction/env-torch-readonly/Scripts/python.exe`. To use another interpreter for this shell:

```powershell
$env:PHOTO_CAD_MESH_PYTHON = 'C:\path\to\python.exe'
node tools/review/preflight.mjs --mode offline
```

If a reviewer needs to build a mesh-only environment, use a 64-bit Python 3.11 installation and install the CPU mesh dependencies explicitly:

```powershell
py -3.11 -m venv .venv-mesh-review
.\.venv-mesh-review\Scripts\python.exe -m pip install numpy trimesh rtree manifold3d
$env:PHOTO_CAD_MESH_PYTHON = (Resolve-Path .\.venv-mesh-review\Scripts\python.exe).Path
node tools/review/preflight.mjs --mode offline
```

For slicing, install the official PrusaSlicer 2.9.6 Windows portable release and extract its console executable under `data/tools/prusaslicer-2.9.6/PrusaSlicer-2.9.6/` as `prusa-slicer-console.exe` (the resolver also accepts `prusa-slicer.exe`). Keep `tools/slicer/fdm-pla-04.ini` in place. The binary is intentionally outside version control; preflight only resolves and asks the existing slicer status provider for its version.

Use the stronger modes only when those capabilities are part of the review:

```powershell
node tools/review/preflight.mjs --mode live
node tools/review/preflight.mjs --mode shape
```

`live` requires both production print and repair AGH status accessors to report ready; this is accessor configuration status, and no model request is sent. `shape` requires the mesh review runtime plus the reconstruction AGH status accessor and all six production generator components to be present: its Python runtime, generator script, pinned upstream source script, model weights, model config, and model manifest. These status checks never print provider configuration or credentials. They do not execute AGH or the generator.

A passing `shape` result is labeled `configured` (including the overall result), never `ready`. Its report explicitly sets `modelRequestVerified`, `inferenceVerified`, `gpuExecutionVerified`, and `cleanMachineReproductionVerified` to false. It is a local configuration and asset-presence preflight, not proof that the GPU can load the model or that a fresh image-to-mesh job succeeds. This command is not a clean-machine reproduction: it does not validate package downloads, GPU drivers, model inference, reviewer account setup, or the end-to-end product flow. Use `--json` for a machine-readable report. Exit codes are 0 when the selected mode is ready (`offline` or `live`) or configured (`shape`), 1 when its prerequisites are blocked, and 2 for invalid command-line input.
