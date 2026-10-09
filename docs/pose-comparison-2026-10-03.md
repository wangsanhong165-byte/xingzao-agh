# 同源打印方案比较：真实验收（2026-10-03）

## 已运行的产品流程

打开 `/reconstruct` 中已完成的任务，点击“比较打印方案”。进入 `/poses` 后可仅比较成本，或输入并确认原模型坐标中的保护体积与包络长度上限。AGH 的真实 Agnes 3.0 Flash 调用原生工具完成检查、四次评估、选择、复查和交付；全部不满足约束时停止。恢复历史任务不会触发新的模型调用。

四个固定候选是直立、绕 X 轴 +30°、绕 X 轴 -30°、绕 Y 轴 +30°。不修改几何形状或尺寸。所有候选使用同一 `fdm-pla-04-auto-support` 配置；它与原配置除 `support_material=1` 外相同。关闭支撑的旧人物基线不用于此次省料比较。

## 本次真实对照

源任务 `1ac90d72-425f-4a6f-b9f8-50248baa6368`，24 万面，最长边 100 mm，源 SHA `8f09708db944f80a3fcdfb0b086e00eb0a83038f668a5a5d58f492e6894be3c9`。输入仍是用户提供的插画三视图，并非普通实拍精度验证。

| 姿态 | 总耗材估算 | 时间估算 | 示范体积内支撑包络近似长度 |
|---|---:|---:|---:|
| 直立 | 75.01 g | 29324 s | 140.34 mm |
| 绕 X +30° | 88.21 g | 32932 s | 197.92 mm |
| 绕 X -30° | 83.60 g | 32276 s | 110.85 mm |
| 绕 Y +30° | 77.16 g | 30242 s | 145.58 mm |

示范体积为原模型坐标 `[[-12,-24,55],[12,-8,85]]`，明确标记 `demonstration-coordinate-bounds`，未将其当作用户已确认的人脸区域。

- **正常样例** `bc9b5d2f-2398-4d3c-a9b3-ca72f314564a`：无保护体积要求，AGH 保留最省料的直立候选，0% 改善；8 次原生业务调用、9 次当前会话的持久化模型请求。
- **约束改变选择** `f6e52902-2f09-4ba3-ab42-765a326d68da`：示范包络上限 120 mm，三个姿态被淘汰，AGH 选择绕 X -30°并复查交付；8 次原生业务调用、6 次持久化模型请求。相对直立，该代理指标约减少 21%，总耗材约增加 11.5%。直立不满足硬约束，因此页面不将它作为合格省料基线输出百分比。
- **失败样例** `143013af-80f0-4437-8347-b6386c0417a4`：同一示范区域的上限设为 0 mm，四个候选均不满足要求，AGH 在 5 次原生业务调用、6 次持久化模型请求后停止；没有 select、verify 或 submit，没有伪造交付。

同样四姿态还通过独立受控悬垂模型测试。该受控模型保持直立更省料；不是每次倾斜都有改善。

## 验证的范围

刀轨先排除模型、裙边、回抽、空走和 Z-hop，区分 support 与 interface，扣除床平移后通过已验证的逆刚体矩阵返回源坐标。线宽与层高构造保守包络，再与指定 AABB 做三维线段裁剪；这不是实际表面接触面积或损伤预测。未提供 ROI 时仅验证总计与成本，明确关键区域未验证。

交付复查从源 STL 重建姿态、核对实际 Float32 文件、源/候选/配置/G-code SHA、位置、保护体积、真实配置层高和重新解析的成本。修改数字、同步缩小两处层高或把 ROI 移到源边界外，都有拒绝回归测试。姿态正体积与刚性变换不替代源模型原有的独立封闭检查。

实际软件运行结果不能证明强度、热变形、附着、表面质量或真实打印成功。保护区域的语义仍需用户确认。

## 原生证据与配置

`data/print-validation/pose-native-<job-id>.json` 将公开任务状态与原生 SQLite 账本交叉核查。三个独立空 workspace 都记录 `session/start` preset 为 `pose-tools`，请求模型为真实 `agnes-3.0-flash`，原生调用与服务事件匹配；不含密钥、任务令牌、原图、提示词、推理或原始私有数据库行。

新插件 `@photo-cad/pose-tools@1.0.0` 的安装完整性为 `sha256-718c9868bce3b6a18787f31cc414ced388a6283b9f3ba4f0700e863b7dfb188a`。通过官方 PackageManager 的 inspect/install/trust/enable 与 active runtime pin 完成登记，profile 显式引用插件，默认 preset `standard-windows` 保留。CLI standalone 的 package admin 方法未注册，使用官方包管理 API；没有放宽权限或修改 AGH 的信任检查。安装状态不能代替运行，另有在 fetch 前完全阻断网络的工具目录探针和真实会话证据。

## 测试与复现

本轮 Node 完整检查 157/157 通过（`data/pose-final-tests.log`）。三类页面完成桌面与 390 px 手机检查，没有页面错误、横向溢出或恢复时自动发起 POST；失败任务隐藏成功交付下载。

本机已有已审模型与工具时：

```powershell
npm.cmd run start:print
node tools/compare-print-poses.mjs --case controlled
node tools/compare-print-poses.mjs --case character
node tools/diagnostics/audit-pose-job.mjs <真实姿态任务UUID>
```

新机器还需按原重建文档准备固定模型、Python、PrusaSlicer、AGH 源码补丁与私有 Agnes 配置，再按 `tools/setup-pose-agh.mjs --inspect` 的实际完整性值安装新插件。大型权重、用户图片、私有 home 和数据库不加入公开源码或提交 ZIP。
