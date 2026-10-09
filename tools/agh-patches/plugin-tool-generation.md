# AGH row-plugin tool generation patch

`plugin-tool-generation.patch` updates an isolated AGH source checkout. Ordinary package rows register tools in the live Kernel registry after `assemble()` may already have created the published session-generation copy. The patch notifies Host when a row adds or releases registrations and replaces only that row's entries in the current generation. This lets later turns see the tools while already-created request snapshots remain unchanged. Revocation mirrors the post-disposal registry so a future turn cannot retain a wrapper for a removed tool.

If generation refresh fails during registration, the row registration is rolled back and the owner refresh is retried after rollback. The Host does not change approval policy, trust, or tool disclosure rules.

Apply from the AGH source root with `git apply <path-to>/plugin-tool-generation.patch`. Validate with `corepack pnpm exec vitest run packages/host/test/ext-host/row-extension-host.test.ts --maxWorkers=1` and `corepack pnpm --filter @agnes/ai --filter @agnes/host --filter @agnes/cli exec tsc -b --pretty false`.

## Runtime verification and remaining blocker

The isolated `data/agh-runtime/agnes.mjs` was rebuilt from this source after the patch. The print-detail package lifecycle is installed, trusted and enabled in `%USERPROFILE%/.agh-print-detail` as `@photo-cad/print-detail-tools@1.0.1`; its inspected integrity is `sha256-2cf1abf6b081b9dff08179b41323887e1af4f80d01d68ac5973ce62a08a1d9a1`, and its capability hash is `e3de4e5f2da4b8aa2650af5c4f822d397c2dadd7a6695e5071c0444d26a22b01`. The isolated `local-dev` daemon was stopped after verification. No print job was created.

A real, no-business standalone V4.1 request completed, but its actual request contained only the 16 built-in tools recorded in `../diagnostics/offered-tool-probe-20261001.jsonl`; no `detail_*` tool was disclosed. `doctor extensions --json` on that standalone path listed built-in rows only, while package status showed the print-detail package enabled and running. This is separate from the row-generation repair above.

The source points to a likely reason: `packages/cli/src/boot/default.ts` sends `--standalone` to `bootLocal`; `packages/cli/src/boot/local.ts` builds the Host with `defaultPackages()`'s `loader` and `packageDirs`, but does not provide `runtimePluginSnapshots` or `runtimePluginSources`. Host assembly initializes its plugin catalogue from `deps.runtimePluginSnapshots ?? []` (`packages/host/src/assemble.ts`) and loads third-party row modules from those snapshots. Therefore this standalone boot has no enabled package-plugin rows to mirror. This is a source-based diagnosis, not a completed fix or runtime test of the daemon-backed session path.

For the next session, first compare the resolved profile's enabled package IDs and runtime snapshot/pin IDs for standalone versus daemon boot. Then make the smallest Host-owned, trust-checked runtime-snapshot handoff for standalone (or run the reviewed AGH task through the daemon-backed transport), and verify that a no-business V4.1 request lists all five `detail_*` tools before starting one print job. Keep the isolated home and current package cache; no raw credentials belong in this note.
