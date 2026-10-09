# Isolated AGH runtime patch

`command-code-v41.patch` adds a fixed Command Code API-key provider to an Agnes Harness source checkout. It registers one reviewed model record, `deepseek/deepseek-v4.1-flash`, through the OpenAI Responses wire format; configuration uses the existing Host Config API and only saves the model when the authenticated `/models` catalogue returns that exact ID. The endpoint is pinned to `https://api.commandcode.ai/provider/v1`.

The patch was developed and tested in the ignored checkout at `data/agh-source`. It does not vendor AGH source or modify the existing installation. Apply it to a separate AGH checkout with:

```powershell
git -C <AGH-source-copy> apply <photo-cad-worktree>\tools\agh-patches\command-code-v41.patch
```

Then run the focused `@agnes/ai`, `@agnes/host`, and CLI provider-registry tests, typecheck those packages, and build the isolated CLI. Configure credentials through `tools/setup-print-agh.mjs` with the AGH source TypeScript loader; never place the API key in command arguments or project files.

# 纹理任务的原生工具边界

适用 Agnes Harness 源码：`ec7ebbdb36e7658d2a121c3ba5113e850b16cb63`。

当前上游 `standard` preset 会披露核心 shell/read 工具；仅注册四个插件工具并不能形成四工具边界。`texture-tool-boundary.patch` 在原生披露和分发两个入口为 `texture-tools` preset 加白名单。其余 preset 沿用上游行为。这里的白名单不是通用操作系统沙箱；本项目的任务令牌、来源哈希、路径检查与受管 Python 进程仍分别执行。

在已安装依赖的 `data/agh-source` 中复现（先确认 HEAD 和工作区，已有相同补丁不重复应用）：

```powershell
git rev-parse HEAD
git apply --check ../../tools/agh-patches/texture-tool-boundary.patch
git apply ../../tools/agh-patches/texture-tool-boundary.patch
Copy-Item -LiteralPath ../../tools/agh-patches/texture-tool-boundary.test.ts -Destination packages/core/test/texture-tool-boundary.test.ts
node node_modules/vitest/vitest.mjs run --project fast packages/core/test/texture-tool-boundary.test.ts packages/core/test/inference.test.ts packages/core/test/tool-dispatch.test.ts --maxWorkers=1
```

在 `data/agh-source` 构建独立输出，不覆盖其他流程的 `data/agh-runtime`：

```powershell
$textureBuildPathBefore = $env:PATH
try {
  $env:PATH = 'C:\Windows\System32;C:\Windows\System32\WindowsPowerShell\v1.0;C:\Windows\System32\Wbem;' + $textureBuildPathBefore
  node --import ./node_modules/tsx/dist/loader.mjs ./packages/cli/tools/build-local.ts --output-dir ../texture-agh-runtime
} finally {
  $env:PATH = $textureBuildPathBefore
}
```

回到项目根目录，`node --env-file-if-exists=.env tools/setup-texture-agh.mjs` 只检查插件并输出 integrity。使用实际检查输出的 integrity 执行 `--install --expected-integrity <检查输出>`，通过上游 package manager 安装、信任、启用及固定快照。该脚本保留现有模型、其他插件和默认 preset，不写入模型密钥。

服务使用 `data/texture-agh-runtime/agnes.mjs`。原生工具超时在插件 preset 的 `tools.timeouts.texture_generate` 设置为 750000ms；整个 AGH 任务另有 1200000ms 上限，服务最多接受八次工具调用。

模型只可调用 `texture_inspect`、`texture_generate`、`texture_verify`、`texture_submit`。这项限制同时在原生 dispatch 执行，不能只依赖提示词。测试文件覆盖披露、未披露 shell 调用拒绝和其他 preset 原行为。
