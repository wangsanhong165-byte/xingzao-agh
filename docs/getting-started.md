# Setup and First Run

English | [简体中文](../运行与模型配置.md) · [Project home](../README.md)

This guide is for a **fresh GitHub clone on Windows x64**. The repository includes source, sample files, and records; it does not include Python environments, slicer executables, model weights, private task data, or accounts. Setup needs access to GitHub, PyPI, PyTorch, and Hugging Face.

## Choose a starting point

| Goal | Requirements | Steps |
| --- | --- | --- |
| Review the included files | Node.js 24.10+ with npm | 1 |
| Generate standard parts and slice again | Above + Python 3.12 x64 | 1–2 |
| Run new AGH manufacturing tasks | Above + Git, AGH build tools, own model account | 1, 3–4 |
| Generate models from images and add color | Above + compatible NVIDIA GPU/driver and CUDA build tools for texture extensions | 1, 3–6 |

The recorded full GPU platform is Windows 11, RTX 5060 Laptop 8 GB VRAM, 16 GB RAM, Python 3.12, and Torch 2.11.0+cu130. CPU manufacturing checks need neither CUDA nor Hunyuan weights. Reserve roughly 40 GB of disk for full setup; shape/texture weights alone are about 13 GiB. Other hardware/software combinations need separate testing.

## 1. Clone and review the included results

Run in PowerShell:

```powershell
git clone https://github.com/wangsanhong165-byte/xingzao-agh.git
cd xingzao-agh
npm.cmd ci
node tools/review/run.mjs
```

Open `复核报告.html` in your browser. Expected results: original upright and boundary-repair rod cases fail their declared checks; the normal repair and side-oriented original pass; the photographic protection example reports approximately 77.33% less regional support path. A successful review means these outcomes match the recorded expectations, not that every candidate passed.

The report and current workbench UI are in Chinese. The review does not call a model and uses cached mesh probes where indicated.

## 2. Generate and slice the standard parts again

```powershell
py -3.12 tools/setup/reproduce.py environment --kind cpu-review
py -3.12 tools/setup/reproduce.py assets --scope slicer
& .\data\reconstruction\env-torch-readonly\Scripts\python.exe tools/setup/reslice.py
```

The installer obtains fixed-version CPU packages and PrusaSlicer 2.9.6. The final command creates new STL/G-code files and opens a result page under `data/reproduction-runs/`. It tests the standard lamp-post geometry and actual slicing, without image inference or an AGH account.

## 3. Prepare tools, AGH, and your account

Install Git and Visual Studio 2022 Build Tools with Desktop development with C++ and the Windows SDK. From the repository root:

```powershell
py -3.12 tools/setup/reproduce.py environment --kind cpu
py -3.12 tools/setup/reproduce.py assets --scope core
& .\data\reconstruction\env-torch-readonly\Scripts\python.exe tools/setup/check_runtime.py --kind cpu
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/setup/agh.ps1 -Action Build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/setup/agh.ps1 -Action Serve
```

The CPU check should report `meshImport: true` and `imageProcessingAvailable: true`. Build obtains AGH commit `ec7ebbdb36e7658d2a121c3ba5113e850b16cb63`, applies [the supplied adaptations](../agh-adaptation/README.md), and builds with pnpm 10.34.5 via npm. The installer refuses conflicting existing source/runtime directories.

Keep Serve running and open the printed AGH URL. In Provider settings configure **your own account**, test the connection, and save it as default. The recorded configuration uses **CommandCode**, base URL `https://api.commandcode.ai/provider/v1`, model `deepseek/deepseek-v4.1-flash`. The project also supports the configured Agnes AI route `agnes-3.0-flash`. Other model routes require code/allowlist validation. Account access and quotas depend on your provider.

Open another PowerShell at the repository root. Stop this dedicated AGH instance, install the plugins, and restart:

```powershell
$env:AGH_HOME = Join-Path $env:USERPROFILE '.agh-print-detail-v2'
$env:PHOTO_CAD_AGH_HOME = $env:AGH_HOME
$env:AGNES_PROFILE = 'local-dev'
node data/agh-runtime/agnes.mjs daemon stop --profile local-dev
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/setup/agh.ps1 -Action Plugins
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/setup/agh.ps1 -Action Serve
```

The Plugins step installs/trusts/enables the four business packages and pins their snapshots. Keep credentials in your private AGH settings; do not copy the developer's account directory or commit keys.

## 4. Start the workbench and run a manufacturing task

In another PowerShell at the repository root:

```powershell
$env:PHOTO_CAD_AGH_HOME = Join-Path $env:USERPROFILE '.agh-print-detail-v2'
npm.cmd start
```

Open **http://127.0.0.1:4337/**. Keep the AGH and workbench processes running.

1. Enter **细杆检查** (thin-rod check), choose **导入自己的STL / GLB**, and select `case/source-original.stl`.
2. Set **目标最长边** to **30 mm**, inspect/import the model, and confirm **12 × 8 × 30 mm**. Continue to the rod check.
3. Choose **Z轴**, keep the default **0.2 mm radial / 20 mm³ added-volume** budget, zoom in, and click the middle of the rod with the selection tool.
4. Confirm the proposed **0.25 mm radius** and full axis **Z=2 to 28 mm**, then start the plan check.
5. Wait for the five-pose comparison and recheck. On success, download STL from the result page and follow **查看姿态任务** to download verified G-code. Save the task URL to reopen the result.

Readiness checks:

```powershell
node tools/review/preflight.mjs --mode offline
node tools/review/preflight.mjs --mode live
```

Offline checks inspect local tools/files; live checks additionally need the account/plugins. A completed task with verified artifacts is the final confirmation of a new execution.

## 5. Optional image modeling and color review

Prepare the separate GPU environments and download pinned model assets:

```powershell
py -3.12 tools/setup/reproduce.py environment --kind gpu
& .\data\reconstruction\env-torch-readonly\Scripts\python.exe tools/setup/reproduce.py assets --scope shape
& .\data\reconstruction\env-texture-probe\Scripts\python.exe tools/setup/reproduce.py assets --scope texture
& .\data\reconstruction\env-torch-readonly\Scripts\python.exe tools/setup/check_runtime.py --kind shape --gpu-smoke
```

| Asset | Fixed upstream revision |
| --- | --- |
| Hunyuan3D-2mv, about 4.59 GiB | `tencent/Hunyuan3D-2mv` @ `3a761b539b29fe4ff64714813aa9560fd66f5de0` |
| Paint Turbo assets, about 8.40 GiB | `tencent/Hunyuan3D-2` @ `9cd649ba6913f7a852e3286bad86bfa9a2d83dcf` |
| Hunyuan source | `Tencent-Hunyuan/Hunyuan3D-2` @ `f8db63096c8282cb27354314d896feba5ba6ff8a` |

The downloader checks file identity and can resume matching assets. Texturing uses an illustration reference, skips Delight, and produces RGB review assets.

## 6. Build texture extensions

The GitHub clone does **not** include precompiled native wheels. For the recorded Torch/CUDA stack, install CUDA Toolkit 13.0 and a compatible NVIDIA driver. Open **x64 Native Tools Command Prompt for VS 2022**, enter the repository root, and run these **CMD** commands (adjust the CUDA installation path if needed):

```bat
set "CUDA_HOME=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.0"
set "CUDA_PATH=%CUDA_HOME%"
set "PATH=%CUDA_HOME%\bin;%PATH%"
data\reconstruction\env-texture-probe\Scripts\python.exe tools\setup\build_native.py
data\reconstruction\env-texture-probe\Scripts\python.exe -m pip install --no-index --no-deps --find-links data\setup\wheels custom-rasterizer==0.1 mesh-processor==0.0.0
data\reconstruction\env-texture-probe\Scripts\python.exe tools\setup\check_runtime.py --kind texture --gpu-smoke
```

The check should show `textureImport: true`, `nativeExtensions: true`, and `rasterVisiblePixels > 0`. The build uses a source copy and the recorded Windows/sm_120 settings. Other Torch/CUDA/GPU combinations require their own build and smoke test.

Back in the workbench, upload front/side/back images, confirm side orientation and size, then generate the white mesh. Color review is optional and takes an illustration reference. Existing geometry can also enter appearance protection or rod checks. Use your own authorized images or the licensed skull views under `case/`; attribution is recorded in [the input manifest](../case/skull-input-manifest.json).

## Troubleshooting and records

| Symptom | What to check |
| --- | --- |
| Page opens, task cannot run | Check AGH Serve, model account, four plugins, and CPU tools; image stages also need GPU assets |
| Old demo task is missing | Private historical jobs are not shipped; use the included report/samples or create a new task |
| Port 4337 is busy | Check for your duplicate workbench process; business plugins target this fixed port |
| File identity mismatch | Check the pinned revision and path; do not disable verification |
| Texture extension fails | Match Python/Torch/CUDA/VS versions and check the rasterizer smoke test |
| GPU memory error | Close other GPU workloads and reduce allowed generation/texture settings; rerun and inspect the actual result |

New jobs and assets are stored under `data/`; new AGH records use your dedicated home. Export them through the AGH Web interface. Existing official-interface exports are under [evidence/agh](../evidence/agh). For wheel downloads, offline installation, and additional setup detail, see [the Chinese configuration reference](../运行与模型配置.md).
