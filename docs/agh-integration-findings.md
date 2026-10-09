# AGH 接入故障与验证记录

2026-10-01。开发模型为 Command Code 的 V4.1 Flash，独立 AGH home 与 profile；不修改用户默认环境，不用直接模型 API 冒充 AGH。

## CLI 的标准输入

AGH `packages/cli/src/modes/prompt-input.ts` 对非终端标准输入等待 EOF，即使 `-p` 已有提示。项目原启动器使用 promisified `execFile`，标准输入管道保持打开，AGH 停在创建会话之前；因此超时记录没有业务工具或 session 事件。

项目启动器现直接结束 child.stdin。独立复现：相同的等待 EOF 子进程，旧包装器超时，新包装器返回 EOF；回归测试覆盖这一行为。原超时任务保留，不改写为成功。

## 命令工具的审批拒绝

修复 EOF 后，真实 AGH 会话创建成功，并三次尝试 builtin shell 调用受限工具桥。执行层均返回 `APPROVAL_REJECTED`，审批记录为同步拒绝；命令未运行，因此服务没有收到 inspect，也没有任何候选。

这是 AGH 本身的审批结果，与当前 Codex 工具权限是两个系统。没有修改拒绝结论、扩大 shell 授权或把模型的 completed 文本当作任务成功。该任务的最终服务状态为 incomplete。

## 普通插件与会话工具表

Host 的普通插件 row 已注册五个工具并发出 extension.registered 审计，正式 package lifecycle 状态为 trusted／enabled／running。但实际模型请求不包含这些工具。

源码定位：`row-extension-host.ts` 的 registrationOf 写 Kernel 工具表；`publishedSessionRuntime` 缓存按 runtimeRegistryRevision 创建的工具表副本。Host 的 mirrorGenerationOwner 只接入动态内置扩展的 late registration，普通插件 row 没有相应同步。修复计划为 Host 可选的注册变化回调：只替换该 owner 在已发布 generation 中的登记，注册、取消与卸载均同步；既有 turn 的固定 snapshot 不改变，信任与审批策略不改变。

需完成新增／撤销的失败回归、Host 类型检查、重建 CLI，再以真实模型请求和业务任务验证。注册日志或单元测试本身不能替代这次真实闭环。

## 2026-10-02：真实根因与正式模型验证

传播补丁已通过相关测试与构建，但其本身没有使独立CLI请求出现业务工具。进一步按实际profile核对，发现锁文件已安装启用的包并未出现在独立运行profile的显式package引用；增加正式用户profile引用后，Host进一步报告缺少immutable runtime snapshot。

后台worker已通过PackageManager读取审核后的active immutable pins，独立CLI的assembleLocalHost却没有传递这批快照。已按后台相同机制补齐：只选profile中启用、trusted、同profile及精确integrity匹配的快照；Host的信任与快照校验仍保持。独立CLI诊断实际加载五个业务插件，源码回归及类型检查通过。补丁见`tools/agh-patches/standalone-plugin-snapshots.patch`。

第一条完整业务链实际使用了旧会话保留的V4.1；配置默认值改变不会追溯替换已存会话模型。其job元数据已按实请求证据纠正，原生记录未改，不能作为Agnes核心证据。runner现用CLI正式`--model primary=route/model`在提示发送前显式绑定模型；对应Agnes／V4.1参数化回归均通过。

正式Agnes任务`651a18df-2cf7-4321-ad1c-26280564ff23`成功提交。实请求追踪14/14为`agnes-3.0-flash`，native ledger与服务的11次业务调用一一对应：检查、基线建模／切片／不通过、0.2mm浮雕建模／切片／一层不通过、0.6mm建模／切片／三层通过、提交。最终几何IoU0.904552、目标区域724.895mm有效挤出，使用固定虚拟配置，尚非实物或通用照片验证。

去敏native证据保存在`data/print-validation/agnes-native-evidence-2026-10-02.json`；模型请求追踪仅记录时间、model与工具名，不记录headers、prompt、reasoning或Key。源码／包版本、配置与复现说明仍须跟最终提交版本保持一致。
