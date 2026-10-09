# Hunyuan3D-2mv private shape-only experiment

These scripts reproduce the local multiview shape experiment in this worktree. They do not provide a generic photo-to-CAD service, do not call a cloud endpoint, do not read an Agnes Key, do not load the texture model, and do not start or submit an AGH task.

The pinned model is Tencent `tencent/Hunyuan3D-2mv`, subfolder `hunyuan3d-dit-v2-mv`, HF revision `3a761b539b29fe4ff64714813aa9560fd66f5de0`, safetensors SHA-256 `d36f5881bcdc56726b73e517cd444c13c60732431622da7268145355c8d38e9c`. Inference source is the official [Tencent Hunyuan3D-2 repository](https://github.com/Tencent-Hunyuan/Hunyuan3D-2) at commit `f8db63096c8282cb27354314d896feba5ba6ff8a`. The cache keeps the official LICENSE and NOTICE; any later distribution must follow the [Hunyuan 3D 2.0 Community License](https://huggingface.co/tencent/Hunyuan3D-2mv/blob/main/LICENSE).

The task-specific Python environment is `data/reconstruction/env-torch-readonly`. It inherits the existing `D:\conda\envs\qwen3-asr` site packages with `--system-site-packages`; **do not pip install, upgrade, remove, or reconfigure anything in that parent environment**. Additional packages were installed into the child venv's own `Lib/site-packages` with `--no-deps`. The inherited Torch 2.11.0+cu130 CUDA smoke test passed on RTX 5060 Laptop (`sm_120`). `mc_algo='mc'` uses scikit-image marching cubes; no CUDA toolkit or `diso` extension is needed.

## Download the pinned local weights

```powershell
& 'data\reconstruction\env-torch-readonly\Scripts\python.exe' `
  tools\reconstruction\download_shape.py --status
& 'data\reconstruction\env-torch-readonly\Scripts\python.exe' `
  tools\reconstruction\download_shape.py --max-seconds 28800
```

The downloader has a fixed HF repository, revision, subfolder and safetensors path. It requests verified HTTPS ranges in 32MiB chunks, checks the response range/length, revision, file size and SHA-256, preserves the current offset on transfer errors, and atomically places the final file only after full hash verification. It does not print signed URLs or modify the Hugging Face cache's partial file.

## Prepare the private illustration sheet

The user-provided setting sheet is 480×270. This helper uses the fixed front/left/back crops in `hunyuan_core.py`, identifies neutral guide rows shared across views, makes only border-connected pale pixels transparent, and keeps the main subject with nearby/large components. It writes original crops, cleaned RGBA views and preprocessing metadata under `data/reconstruction/generated/<run-id>/`. It saves source/view hashes, not the original path or embedded image bytes.

```powershell
& 'data\reconstruction\env-torch-readonly\Scripts\python.exe' `
  tools\reconstruction\prepare_character_sheet.py `
  --image 'C:\path\to\authorized-480x270-sheet.png' `
  --run-id user-character-views
```

This fixed-sheet cropper is an experiment helper, not general image matting. Inspect the before/after PNGs; gray guide fragments and details that share the background can remain or be removed.

## Run local shape generation

For separate user-provided views, the side panel that faces image-left maps to Hunyuan's `left` view. Input files are local PNG/JPEG images; each has a 5MiB and 12-megapixel limit.

```powershell
& 'data\reconstruction\env-torch-readonly\Scripts\python.exe' `
  tools\reconstruction\generate_hunyuan_multiview.py `
  --front 'data\reconstruction\generated\user-character-views\views-cleaned\front.png' `
  --left 'data\reconstruction\generated\user-character-views\views-cleaned\left.png' `
  --back 'data\reconstruction\generated\user-character-views\views-cleaned\back.png' `
  --steps 25 --resolution 256 --num-chunks 8000 --seed 12345 `
  --target-longest-edge-mm 100 --run-id user-character-shape
```

Allowed CLI settings are 5–50 steps, octree resolution 128/256/384, chunk count 4000/8000/20000, a 32-bit seed, and user-provided 1–180mm longest-edge scale. The 384 option is a bounded experimental CLI setting; the AGH reconstruction tools continue to offer only 128/256. Higher extraction resolution alone is not a guarantee of additional semantic geometry detail. No scale is inferred from the drawing. The output keeps the raw Y-up GLB and a separately transformed Z-up STL, with the rotation/scale matrix, hashes, timings, memory, bounds and topology checks in `generation.json`. Blender's glTF importer converts the raw GLB to Blender's Z-up coordinate frame once; the print-ready STL is already Z-up.

Generation holds an application-local process lease at `data/reconstruction/gpu-lease.json`. A live or inaccessible owner causes `GPU_BUSY`; a proven-dead owner may be recovered without killing any process. Windows uses query-only process APIs, not `os.kill`. The lease coordinates this application only and cannot prevent other software from using VRAM.

When a full STL exceeds the importer limit (250,000 triangles or 25MiB), the raw mesh remains unchanged and a topology-preserving 240,000-face copy is also saved. Its report measures bidirectional vertex-sampled surface distance to the raw mesh; this is an approximation, not a continuous Hausdorff guarantee.

## Render the generated raw GLB

```powershell
& 'C:\Program Files\Blender Foundation\Blender 4.5\blender.exe' `
  --background --python tools\reconstruction\render_hunyuan_views.py -- `
  --run-id user-character-shape
```

The Blender script imports `raw-y-up.glb`, produces front/left/back/perspective PNGs, checks scene world bounds and mesh edge incidence, and saves a `.blend` preview. The views are inspection evidence; they do not establish exact reconstruction.

Run offline helper tests with:

```powershell
& 'data\reconstruction\env-torch-readonly\Scripts\python.exe' tools\reconstruction\test_hunyuan_core.py
& 'data\reconstruction\env-torch-readonly\Scripts\python.exe' tools\reconstruction\test_download_shape.py
```

This experiment generates geometry only. It does not validate self-intersections, slicing, support, printer profile, mechanical strength, or actual print quality; a closed mesh is not a printability claim. No texture synthesis is performed.

## Critical-feature inspection dependencies

`feature_probes.py` uses the isolated child environment and pinned Rtree 1.4.1 to inspect actual source surfaces and void channels. `feature_fixture.py` additionally uses Manifold3D 3.2.1 to construct the controlled closed test pieces; this is not a generation-model dependency. Install these into the child environment only, never the inherited parent:

```powershell
& 'data\reconstruction\env-torch-readonly\Scripts\python.exe' -m pip install --isolated --no-deps rtree==1.4.1 manifold3d==3.2.1
& 'data\reconstruction\env-torch-readonly\Scripts\python.exe' -m pytest tools/reconstruction/test_feature_probes.py tools/reconstruction/test_feature_fixture.py -q
```

For a same-view geometry review of two completed local generation runs:

```powershell
& 'C:\Program Files\Blender Foundation\Blender 4.5\blender.exe' --background --factory-startup --python tools/reconstruction/render_hair_comparison.py -- --baseline user-character-shape --candidate user-character-shape-384
```

The renderer checks the full STL against its generation hash, uses one shared neutral material and camera setup, saves six PNGs plus settings, and does not modify either source.

## Local rod repair

`local_rod_repair_v2.py` uses Trimesh and Manifold3D 3.2.1 for new local-repair tasks and controlled tests. It selects the declared rod's nearby contours and relevant axial events without rejecting unrelated distant structure. It reads the actual source STL, checks a declared axis-aligned circular solid rod, performs a bounded cylinder union, and verifies the written candidate against the source and requested operation. Original coordinates and global bounds remain fixed. It checks added-material extent/volume, source removal, adjacent geometry, and candidate-to-expected symmetric difference; sampled distance is not a continuous Hausdorff bound. The original `local_rod_repair.py` bytes remain unchanged for historical receipts; Node selects a known verifier by its recorded SHA and rejects unknown fingerprints.

The internal CLI accepts a 64 KiB JSON request only below `data/repair-jobs/<uuid>/<action>/request.json`; output stays in the same action directory. Only inspect/apply/verify are supported. It does not accept arbitrary shell commands or general mesh editing instructions. Source and candidate files are capped at 25 MiB and 250,000 triangles. More than 256 relevant axial events is refused, not silently undersampled.

```powershell
& 'data\reconstruction\env-torch-readonly\Scripts\python.exe' -m pytest tools/reconstruction/test_local_rod_repair.py -q
```

The `/repair` workflow uses a separate reviewed AGH plugin and binds these proofs to the existing failed pose task, source hash, fixed pose/profile, feature definitions and user budget. See `docs/local-rod-repair-validation-2026-10-04.md` for actual runs and limitations.

## Experimental reference colors

`project_vertex_color.py` evaluates CPU reference-image projection into glTF `COLOR_0` on an unchanged source mesh. It uses existing packages, conservative first-hit visibility and opaque neutral gray for unknown vertices. Image samples are decoded from sRGB to linear vertex colors. It exports source-local geometry with a standard Z-up/mm → Y-up/metres scene node, then reimports and compares oriented float32 triangle fingerprints and that node transform.

This is an internal experiment helper, not a public color upload endpoint or UV/material-generation feature. Camera/bbox alignment is uncalibrated; vertex coverage is not surface area coverage or color accuracy. Existing experiment output IDs should be kept distinct to preserve records. See `docs/color-projection-experiment-2026-10-04.md` for actual visual results and the decision not to promote it as complete color delivery.

```powershell
& 'data\reconstruction\env-torch-readonly\Scripts\python.exe' tools/reconstruction/project_vertex_color.py --help
```
