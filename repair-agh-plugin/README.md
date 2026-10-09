# `@photo-cad/feature-repair-tools`

This independent AGH extension exposes five bounded native tools for repairing a failed critical feature on a derived candidate: `repair_inspect`, `repair_evaluate`, `repair_apply`, `repair_verify`, and `repair_submit`. It exports the `feature-repair-tools` preset, which extends `standard` and leaves the standard 120 second native timeout unchanged.

The extension communicates only with `http://127.0.0.1:4337/api/repair/tool/{operation}`. It sends the task job ID and task-scoped `PRINT_TASK_JOB_ACCESS` nonce in the `X-Print-Task-Access` header. The service supplies the allowed `repairOptionsMm`; the agent can choose only an exact listed value. A repaired candidate ID must come from `repair_apply`, at most three repair candidates are allowed, verification requires a feasible evaluation of that exact ID, and submission requires its successful verification. The plugin has a 12-call budget and a 90 second HTTP deadline.

## Installation lifecycle

`node tools/setup-repair-agh.mjs` performs an official PackageManager `inspect` of the local package and prints its source integrity and declared capabilities without installing it. Review the package source and inspect output first. To install a reviewed preview, pass the exact integrity reported by that invocation:

```powershell
node tools/setup-repair-agh.mjs --install --expected-integrity sha256-<exact-preview-integrity>
```

The install path uses AGH's official PackageManager to install against the expected integrity, trust the capability hash, enable the installed package, and pin its active runtime snapshot. It then adds this package and preset to `local-dev` while preserving the existing default preset and unrelated package entries. It does not configure or print provider credentials. The runner explicitly binds the currently verified provider route and model from the isolated AGH configuration for each task.

## Evidence boundary

This package coordinates service operations; it does not edit geometry or declare a repair valid. The local repair service owns immutable source evidence, candidate generation, fresh geometry and critical-feature checks, actual slicing, verification, and delivery. Tool responses are accepted only when their operation-specific candidate ID and feasibility fields match the requested operation. A rejected or failed original candidate remains part of its original job evidence.
