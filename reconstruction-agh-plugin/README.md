# `@photo-cad/reconstruction-tools`

This package adds five bounded native AGH tools for three-view mesh reconstruction. It also exports an AGH preset named `reconstruction-tools`. That preset extends the standard recipe, keeps the standard 120 second default timeout for other tools, and raises only `mesh_generate` to 330 seconds.

The long generation deadline is native AGH policy. The kernel selects `preset.tools.timeouts[toolName]`, puts that value in `ToolContext.timeoutMs`, and cancels execution at the same deadline. The plugin caps its HTTP request below that native deadline and follows the native abort signal. If the resolved per-tool timeout is absent, the plugin assumes the documented 120 second base default and the request ends with a deadline error; it does not pretend the kernel granted a longer call.

## Profile selection

Install and review the package through the normal AGH package lifecycle. In the dedicated reconstruction profile, select the package-provided preset using the profile schema's supported `presets` selection fields:

```yaml
presets:
  default: standard-windows
  allowed: [standard-windows, reconstruction-tools]
```

The current resolved v2 profile uses `standard-windows`; keep that default and append `reconstruction-tools` to its `presets.allowed` array. The runner selects this preset explicitly with `--preset reconstruction-tools`, so the existing print workflow retains its current default. Do not put `tools` or `timeouts` directly in `profile.yaml`; those are fields of a preset document. The package exports the preset document so AGH resolves it through its package catalog.

Before any model task, inspect only the resolved preset selection. Capture the full command output in a PowerShell variable and print only the public `presets` field:

```powershell
$resolvedProfile = agnes profile inspect local-dev --resolved | ConvertFrom-Json
$resolvedProfile.presets | ConvertTo-Json -Compress
```

Confirm that the package is present, `presets.default` remains `standard-windows`, and `presets.allowed` includes `reconstruction-tools`. Then resolve the actual merged preset offline from the AGH source checkout. From `data/agh-source/packages/host`, run:

```powershell
& '..\..\node_modules\.bin\tsx' -e "import { resolvePreset } from './src/presets/resolve.ts'; import { presets as base } from '../base/src/index.ts'; import { presets as code } from '../code/src/index.ts'; import { presets as reconstruction } from '../../../../reconstruction-agh-plugin/index.mjs'; const p = resolvePreset('reconstruction-tools', { ...base, ...code, ...reconstruction }); console.log(JSON.stringify({ name: p.doc.name, timeoutMs: p.view.tools.timeoutMs, meshGenerateTimeoutMs: p.view.tools.timeouts.mesh_generate }));"
```

Expected output is `{"name":"reconstruction-tools","timeoutMs":120000,"meshGenerateTimeoutMs":330000}`. This imports preset definitions and calls AGH's resolver only; it does not load a profile configuration, read credentials, connect to a provider, or start a model task. The profile inspection separately confirms that the selected profile allows this preset.

The CLI task limit remains 600 seconds. The local generation service has its own 300 second bound. These limits do not promise physical printability or an optimal reconstruction.
