# AGH v2 隔离配置与离线工具目录探针（2026-10-02）

旧隔离 home 的根目录未通过 AGH 官方 private-DACL 检查，官方 credential store 因权限模式拒绝使用。旧目录与内容均保留，没有放宽 ACL、复制凭据或重写 secret。随后通过 AGH 官方私有目录流程创建 `.agh-print-detail-v2`，并在该 home 中配置 Agnes 账户。第一次使用 v2 的任务仍未加载打印工具；诊断确认缺少 `local-dev` profile 定义。根代理只补入非秘密 profile 定义，显式引用已启用的 `@photo-cad/print-detail-tools` 1.0.1。失败任务 `9eba82a1-ebc2-4707-ac90-8fd2e41603de` 保留为失败证据：请求里只有内置工具，未执行打印业务工具。

为了在启动 M3 前确认插件已进入实际 AGH 请求目录，运行了编译后 CLI 的离线探针。探针使用 v2 home 和 `local-dev`，在官方 Agnes chat-completions `fetch` 发出前记录允许的元数据并抛出拦截错误；网络请求没有发送，也没有调用任何模型或业务工具。捕获到 `agnes-3.0-flash`，请求工具名包含 `detail_inspect`、`detail_build`、`detail_slice`、`detail_verify`、`detail_submit`，同时包含若干 AGH 内置工具。CLI 以预期拦截错误退出，session 为 `c241817512fbc0db`。这证明实际组装出的请求包含插件工具，不代表模型推理或打印任务成功。

去敏探针记录位于 [`data/print-validation/offline-agnes-tool-names-20261002.json`](../data/print-validation/offline-agnes-tool-names-20261002.json)。诊断实现 [`tools/diagnostics/offline-agnes-tools.mjs`](../tools/diagnostics/offline-agnes-tools.mjs) 只允许在探针子进程中加载；它从不调用原始 `fetch`，且拒绝所有非目标请求。对探针新增的单测通过。

根代理随后启动并完成了唯一一条真实 v2 M3 回归 `e886dcdc-17db-4cf7-99b8-d1233384ae15`。native session `agnes:local:local-dev:cli:workspace:c241817512fbc0db` 在 `11:58:45.659Z` 至 `12:00:33.929Z` 执行了该 turn。窗口内 model trace 有 14 个 Agnes 3.0 Flash 请求；native ledger 记录 12 次业务调用：2 次 inspect、3 次 build、3 次 slice、3 次 verify、1 次 submit。第二次 inspect 是真实的重复调用，保留在记录中。之前的 v2 失败任务不计入这些数量。

回归输入为 40 × 30 mm、底板厚度 2 mm；验证策略要求目标覆盖率至少 0.90、spill 不超过 0.15、孔剩余比例至少 0.80、至少 2 个模型层。闭合底板基线通过网格检查，但无凸起路径（0 层），因此 verify 失败。0.2 mm 候选有 1 层，也未满足层数门槛。模型随后构建、切片并验证 0.4 mm 候选：目标覆盖率 0.91883、spill 0.020532、唯一目标孔剩余面积比例 0.9948 且保持连通、fidelity 0.904552、凸起路径 2 层。它通过校验并提交，切片估算为 2.26 g、906 秒。切片使用虚拟 `fdm-pla-04` profile；这不是实体打印结果。

完整去敏 native 事件和 14 个 trace 时间戳按本任务窗口导出到 [`data/print-validation/agnes-m3-native-evidence-2026-10-02.json`](../data/print-validation/agnes-m3-native-evidence-2026-10-02.json)。记录只保留工具名称、候选 ID、受限参数、策略数值和结果指标，不含 prompt、图片、reasoning 或凭据。离线探针结果单独存放，不计入 model request 或业务工具调用。
