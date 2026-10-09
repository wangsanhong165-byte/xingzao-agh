# Cached review bundle checker (2026-10-07)

Run the checker from an extracted review bundle directory, or point `--bundle` at that directory. It uses Node's built-in modules and the checked-in review audit helpers; it does not require a GPU, API access, downloads, or npm package installation.

```powershell
node tools/review/check.mjs --bundle .\review-bundle
node tools/review/check.mjs --bundle .\review-bundle --json
```

When running inside the bundle root, omit `--bundle` to check the current directory:

```powershell
node tools/review/check.mjs
```

The checker verifies every manifest-listed file's byte count and SHA-256, rejects duplicate/traversing/link paths, and enforces caps of 512 files, 25 MiB per file, and 190 MiB total. It then re-creates each declared rigid pose from its bundled raw STL, compares the resulting posed STL hash, checks cached probe files against their declared source hashes, independently parses MODEL extrusion coordinates and their virtual-bed placement, reruns the feature and rod-continuity audits against the cached probes and G-code, recalculates slicer metrics, and recomputes the declared budget-failure radius options.

The result is scoped to cached file bindings and G-code re-audit. Probe hashes bind the cached probes to declared source bytes; the checker does not regenerate probes or recompute source mesh membership. It does not replay AGH, regenerate meshes, load Hunyuan weights, run model inference, or verify a physical print. Those limits are returned in the JSON claims and printed by the human-readable report.

A valid bundle exits 0. Invalid, incomplete, oversized, tampered, or inconsistent evidence exits 1. `--json` emits the case audits and explicit scope/claim fields as machine-readable JSON.
