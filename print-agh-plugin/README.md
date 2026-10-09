# Print detail tools for Agnes Harness

This package registers five bounded tools: `detail_inspect`, `detail_build`, `detail_slice`, `detail_verify`, and `detail_submit`. They call only the photo-cad loopback service at `http://127.0.0.1:4337`; the job identifier and short-lived access token are provided by the AGH task runner and are not part of the model prompt. The plugin refuses calls after 12 tool invocations, binds each session to one job, and requires a built candidate to pass slice and verification before submission.

The task runner records `execution.mode = "agh"` and asks the configured V4.1 account to use these native plugin tools. The isolated AGH Host refreshes published session generations when a row adds or revokes tools, so later turns receive the live definitions while already-built request snapshots remain unchanged. Calls use a task-scoped environment credential and contact only the fixed loopback endpoints. The runner does not fall back to shell or report an action as completed unless the AGH task itself completed.

The runtime must be the isolated AGH build containing the reviewed `command-code` provider. Configure its account through the Host Configuration Service using `tools/setup-print-agh.mjs`; that setup checks the provider's authenticated model catalog and saves only `deepseek/deepseek-v4.1-flash` under `%USERPROFILE%/.agh-print-detail`. It does not call the model directly.

Package installation follows the AGH lifecycle: inspect the local source, add it disabled, review its integrity and capabilities, trust the exact preview hashes, then enable. The plugin should report `enabled`, `running`, and `trusted` in `package status` before a job starts. Trust may refuse a package whose declared license is outside AGH's allowlist.

The `submit` tool accepts only the same server-generated candidate whose geometry, actual slicer output, and raised-detail path have passed the server-side checks. The model cannot choose an endpoint, read a local image path, or submit a reconstructed model specification.
