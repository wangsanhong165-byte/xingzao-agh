# Integration Standards

English | [简体中文](integration.zh-CN.md) · [Project home](../README.md)

This page documents the **implemented local integration contract**, not a new industry protocol. It covers AGH plugins, HTTP calls, artifact formats, and reproducible execution.

## 1. Runtime compatibility

| Component | Project contract |
| --- | --- |
| Workbench | Node.js 24.10+, ECMAScript modules, loopback HTTP at `http://127.0.0.1:4337/` |
| AGH | Base commit `ec7ebbdb36e7658d2a121c3ba5113e850b16cb63` with [project adaptations](../agh-adaptation/README.md) |
| Plugins | Package `agnes.plugins` descriptors; `apply(ctx)` registers tools through `ctx.extension().registerTool()` |
| Tool arguments | JSON Schema-style objects with the TypeBox kind marker; defined properties and `additionalProperties: false` |
| Python workers | Python 3.12; separate geometry/shape and texture environments |
| Slicer | PrusaSlicer 2.9.6 and project profiles under [tools/slicer](../tools/slicer) |

Build/install instructions are in [getting started](getting-started.md). The setup script installs, trusts, enables, and snapshots the four business plugins against the pinned runtime. Compatibility with a newer AGH revision requires separate validation.

## 2. AGH tools and execution order

| Package | Registered tools | Required order |
| --- | --- | --- |
| [reconstruction-agh-plugin](../reconstruction-agh-plugin/index.mjs) | `mesh_inspect`, `mesh_generate`, `mesh_validate`, `mesh_slice`, `mesh_submit` | Inspect → generate → validate → actual slice → submit |
| [texture-agh-plugin](../texture-agh-plugin/index.mjs) | `texture_inspect`, `texture_generate`, `texture_verify`, `texture_submit` | Inspect → generate → verify exact attempt → submit |
| [pose-agh-plugin](../pose-agh-plugin/index.mjs) | `pose_inspect`, `pose_evaluate`, `pose_select`, `pose_verify`, `pose_submit` | Inspect → evaluate every declared pose → select feasible recommendation → verify → submit |
| [repair-agh-plugin](../repair-agh-plugin/index.mjs) | `repair_inspect`, `repair_evaluate`, `repair_apply`, `repair_verify`, `repair_submit` | Inspect → evaluate original → apply an allowed repair after failure → evaluate → verify → submit |

For repair, an original candidate that passes can proceed to verification without `repair_apply`. The workbench's `fixed-five-v2` policy uses `upright`, `tilt-x-plus`, `tilt-x-minus`, `tilt-y-plus`, and `face-up`. The low-level pose API defaults to legacy `fixed-four-v1` when `posePolicy` is omitted, so API clients must request `fixed-five-v2` explicitly for five poses. Repair candidate IDs are `original` and service-issued `r01`–`r03`. Texture attempts are `t01`/`t02`; the `compact` profile is eligible only after a real standard-profile resource failure.

Generation, repair, and tool calls have finite per-session budgets. Clients must follow returned candidates/options instead of inventing IDs, retrying indefinitely, or bypassing verification.

## 3. Local HTTP interfaces

| Purpose | Routes |
| --- | --- |
| Runtime status | `GET /api/{reconstruction,texture,poses,repair}/status` — choose one module name |
| Start a job | `POST /api/{module}/start` with the module's validated input |
| Read a job | `GET /api/{module}/jobs/{jobId}` |
| Reconstruction tools | `POST /api/reconstruction/tool/{inspect,generate,validate,slice,submit}` |
| Texture tools | `POST /api/texture/tool/{inspect,generate,verify,submit}` |
| Pose tools | `POST /api/poses/tool/{inspect,evaluate,select,verify,submit}` |
| Repair tools | `POST /api/repair/tool/{inspect,evaluate,apply,verify,submit}` |

Braces in the table denote alternatives/placeholders, not literal URLs. Use the browser workbench to create tasks and confirm selections. Start requests return HTTP **202** with `{ "id": "…", "stage": "…" }`; clients then read the module's job endpoint. Input fields are module-specific; the authoritative validators live in [reconstruction jobs](../src/reconstruction-jobs.mjs), [texture jobs](../src/texture-jobs.mjs), [pose jobs](../src/pose-jobs.mjs), and [repair jobs](../src/repair-jobs.mjs).

Tool calls use UTF-8 JSON, `Content-Type: application/json`, a `jobId` body field, and the **`X-Print-Task-Access`** header. The job must have an active AGH run and a matching task token. Tokens are injected by the runner, not supplied by end users or copied from published traces:

| Plugins | Runner-provided environment |
| --- | --- |
| Reconstruction, pose, repair | `PRINT_TASK_JOB_ID`, `PRINT_TASK_JOB_ACCESS`; reconstruction also accepts the validated `PRINT_TASK_SERVICE_URL` |
| Texture | `PHOTO_CAD_TASK_ID`, `PHOTO_CAD_ACCESS_TOKEN`, `PHOTO_CAD_SERVICE_URL` |

Example inside an authorized active-task adapter:

```javascript
async function inspectPose(jobId, accessToken) {
  const response = await fetch('http://127.0.0.1:4337/api/poses/tool/inspect', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Print-Task-Access': accessToken,
    },
    body: JSON.stringify({ jobId }),
  });
  const result = await response.json();
  if (!response.ok || result.success !== true) {
    throw new Error(result.reason ?? result.code ?? result.error ?? `HTTP ${response.status}`);
  }
  return result;
}
```

A successful HTTP response does not by itself mean a feasible candidate: inspect the operation's `success`, `feasible`, `valid`, verification, and delivery fields as applicable. For example, pose access denial returns HTTP 403 with `success: false` and `code: "POSE_TASK_ACCESS_DENIED"`; stale pose download hashes return HTTP 409 with `error: "POSE_STALE_SHA"`. Other modules have their own codes.

Readiness can be checked without a task token:

```powershell
Invoke-RestMethod http://127.0.0.1:4337/api/poses/status
```

### Example: import the standard STL and start a five-pose task

Run from the repository root after completing the CPU/AGH setup. Import requires the CPU tools; starting the task additionally requires your configured AGH model account. These public start endpoints do not require a tool token; the runner creates it internally.

```powershell
$file = (Resolve-Path 'case/source-original.stl').Path
$payload = @{
  name = 'source-original.stl'
  mime = 'model/stl'
  sourceUnits = 'mm'
  targetLongestEdgeMm = 30
  dataBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($file))
} | ConvertTo-Json -Depth 6
$model = Invoke-RestMethod http://127.0.0.1:4337/api/model-import -Method Post -ContentType 'application/json' -Body $payload
$poseRequest = @{
  sourceKind = 'imported'
  sourceCandidateId = $model.candidateId
  posePolicy = 'fixed-five-v2'
} | ConvertTo-Json
$job = Invoke-RestMethod http://127.0.0.1:4337/api/poses/start -Method Post -ContentType 'application/json' -Body $poseRequest
Invoke-RestMethod "http://127.0.0.1:4337/api/poses/jobs/$($job.id)"
```

This minimal example compares poses without declaring a protected region or rod, so it does **not** request those feature checks. Use the workbench to select and confirm a rod/region, or supply the validated `criticalFeatures`, `continuousRods`, or `protectedRegions`/`maxRegionSupportPathLengthMm` fields. Poll the returned job ID; only `stage: "completed"` with a successful `recheck` is a verified delivery. `no-feasible`, `failed`, and `interrupted` are stopped outcomes. Use the task's returned STL/G-code URLs rather than constructing a download hash yourself.

## 4. Artifact and measurement conventions

| Item | Convention |
| --- | --- |
| Geometry | STL for manufacturing; GLB/glTF binary for textured review; STL does not retain color |
| Dimensions | Millimeters after explicit scale confirmation; STL carries no reliable unit metadata |
| Coordinates | Keep source coordinates, print transforms, and bed placement separate; use recorded transforms to compare the same region |
| Toolpaths | G-code from the pinned slicer/profile; model/support roles are parsed from slicer comments |
| Coverage | Positive model extrusion only; support/travel are excluded from model coverage |
| Unsupported paths | Arc extrusion is not included in the line-segment audit; the included review rejects unsupported arc extrusion |
| File identity | SHA-256 binds source, candidate, configuration, and output; use the exact download URL/hash returned by the task |
| Records | Task JSON/events and AGH interface exports; original exports remain under [evidence/agh](../evidence/agh) |

The parser handles positioning/extrusion state (`G90/G91`, `M82/M83`, `G92`) and unit conversion (`G20/G21`). See [slicer.mjs](../src/slicer.mjs) for the accepted dialect. A different slicer or profile needs parser/role/placement validation before its results are comparable.

## 5. Extending the project

1. Add a service operation with validated input, explicit units, finite candidates, and a checkable result.
2. Expose it through an AGH plugin with a bounded argument schema and the task's existing HTTP binding.
3. Connect feedback to task state and enforce verification before delivery; preserve original source identity.
4. Validate the new operation with representative input, rejected input, and a fresh tool execution. Keep file-only review distinct from a new run.

The server binds to loopback. This release integrates software tools; MHS/printer hardware control and a public hosted API are not implemented.
