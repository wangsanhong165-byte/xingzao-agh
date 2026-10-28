# Results and Evidence

English | [简体中文](results.zh-CN.md) · [Project home](../README.md)

This page can be read directly on GitHub. To recompute the checks locally, run `node tools/review/run.mjs` from the repository root and open the generated `复核报告.html` in a browser.

## 1. From reference views to a reviewable model

![Reference front, side and back views beside the generated character mesh, taken from the submitted demo](assets/modeling-preview.png)

The recorded workflow runs local Hunyuan3D-2mv and then checks/slices the generated mesh. Color review is a separate optional stage. The original video includes three textured character examples; the public reproducible input set uses the licensed [skull photographs and input manifest](../case/skull-input-manifest.json).

## 2. Less support near a protected surface

The photographic skull example compares the same source, scale, protected region, and slicer profile. The protected source-space box is **40 × 25 × 35 mm**. The task targets at least **50%** less regional support path; `face-up` meets that target.

| Metric | Upright | Selected face-up |
| --- | --- | --- |
| Support extrusion path near the protected region | 34,898.410 mm | 7,911.026 mm |
| Regional path reduction | Baseline | **77.33%** |
| Whole-part filament estimate | 39.01 g | 33.81 g |
| Print-time estimate | 10,908 s | 9,333 s |

The regional path metric estimates the overlap of planned support extrusion with the protected region. It is not total material savings or a measured surface-damage rate.

Evidence: [case/transform data](../examples/photo-protection/case.json), [baseline G-code](../examples/photo-protection/upright.gcode), [selected G-code](../examples/photo-protection/face-up.gcode), [recheck script](../examples/photo-protection/复核支撑.mjs), [recorded tool-call summary](../examples/photo-protection/native-summary.json).

<details>
<summary>Open the recorded workbench result</summary>

![Recorded workbench result showing the protected region, completed tool stages and measurements](../examples/photo-protection/实际页面.png)

</details>

## 3. Thin rods: sampling and full continuity

The controlled lamp-post is **12 × 8 × 30 mm**. The confirmed centerline is **26 mm** long. With the fixed **0.4 mm nozzle / 0.2 mm layer-height** profile:

| Candidate | Centerline coverage | Largest gap | Toolpath decision |
| --- | --- | --- | --- |
| Original 0.5 mm, upright | 4.6% | 24.8 mm | Reject |
| Local repair to 0.7 mm, upright | 88.5% | 0.4 mm | Reject, even though feature samples pass |
| Local repair to 0.8 mm, upright | 100% | 0 mm | Pass |
| Original 0.5 mm, side-oriented | 100% | 0 mm | Pass without changing shape |

The repair sequence and later five-pose original-delivery task are **separate experiments**. The latter delivers the unchanged original in the side-oriented pose, with slicer estimates of **0.80 g / 346 s**. A tighter radial-growth budget yields no allowed thickening candidates; it does not prevent an independently feasible original pose.

![Side-oriented original lamp-post result from the recorded demonstration](assets/rod-preview.png)

Evidence: [case definitions](../case/cases.json), [original STL](../case/source-original.stl), [original upright G-code](../case/baseline.gcode), [0.7 mm G-code](../case/boundary.gcode), [0.8 mm G-code](../case/normal.gcode), [original side-pose G-code](../case/face-up.gcode), [five-pose source/evidence files](../case/five).

## 4. Inspect the agent's execution

The [AGH interface exports](../evidence/agh) contain the normal task, failure task, and small-budget task. They record model/tool calls and outcomes. The [repair summary](../case/native-summary.json) and [photographic-pose summary](../examples/photo-protection/native-summary.json) provide shorter entry points.

## Reproduce at the right level

| Goal | How |
| --- | --- |
| Recalculate included G-code checks | `node tools/review/run.mjs` — no account or GPU |
| Generate and slice new standard parts | [Setup, step 2](getting-started.md#2-generate-and-slice-the-standard-parts-again) |
| Execute a new AGH task | [Setup, steps 3–4](getting-started.md#3-prepare-tools-agh-and-your-account) |
| Image inference and color review | [Setup, steps 5–6](getting-started.md#5-optional-image-modeling-and-color-review) |

File-only review uses cached mesh probes and does not repeat image inference. Physical printing, fit, adhesion, and strength have not been experimentally validated in these examples. Model weights, private images, and the developer's task database are not included.
