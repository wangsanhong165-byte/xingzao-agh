# `@photo-cad/pose-tools`

This AGH extension provides five bounded tools for selecting one of four fixed orientations from the pose job service. It exports the `pose-tools` preset, which extends `standard` and leaves the standard 120 second tool timeout intact. Each pose slice is expected to take about 12 seconds.

The tools are `pose_inspect`, `pose_evaluate`, `pose_select`, `pose_verify`, and `pose_submit`. They accept no model, URL, path, shell command, or caller-selected profile data. Each request goes to the fixed local endpoint `http://127.0.0.1:4337/api/poses/tool/{operation}` and carries the task job id plus the task-scoped access header. A session permits at most 12 calls; inspect must precede evaluation, each pose can be attempted once, selection requires a successful evaluation, verification requires selection, and submission requires successful verification. The service can require all four evaluations before final selection and is authoritative about recommendations and hard constraints.

The AGH runner binds `agnes-ai/agnes-3.0-flash` explicitly in the isolated `local-dev` profile and supplies a fresh empty working directory per job. Keep shape, dimensions, and the shared auto-support profile unchanged. The ROI envelope length is an approximation; tool results do not establish actual contact, load capacity, or physical success.
