# 执行检查点（2026-10-02）

计划按连续里程碑推进，日期是最晚边界，不因日期尚未到而等待。本文件仅汇总已经发生的结果，不取代运行记录。

| 项目 | 当前证据与状态 |
|---|---|
| 正式 Agnes + AGH 原生工具闭环 | 任务 `651a18df-2cf7-4321-ad1c-26280564ff23` 已运行；14次请求为 Agnes 3.0 Flash，11次业务工具调用，保留失败后调整及有效提交；仅受控圆环案例 |
| 更严格平面路径评价 | 已实现并实际切片测试4正常、2边界、2失败；正常样例与偏心 ROI 通过，低高度不可行/空白/越界被拒绝；直接工具执行，尚不能替代新版本 AGH 回归 |
| 新版本 AGH 回归 | 原启动失败与缺工具失败均保留；隔离home v2和显式profile修复后，`e886dcdc-17db-4cf7-99b8-d1233384ae15`真实完成14次Agnes请求、12次业务工具调用；0.2mm一层失败后改0.4mm，两层/覆盖91.883%/孔余量99.48%通过 |
| STL / GLB 导入 | 实际API和浏览器验证；归一化 XY 居中/Z从0起、尺寸手动指定、SHA校验、几何缺陷可见；独立检查，不属于 AGH 模型调用 |
| 省料对照 | 三份受约束参数化盒体真实切片；15.06/12.91/10.75g，独立STL拓扑/射线采样；未验证强度，也未接入AGH |
| 专业多视图建模 | 三视图插画真实25步/256推理约87.6s，峰值5559.2MiB（约5.43GiB）；去标注干扰后结果改善，完整网格56.2万面，另240k副本通过几何导入和真实切片基线（500层/31.95g估算），不代表实物打印成功 |
| 用户主输入与完整流程 | 专业模型、网格检查及切片目前仍是直接工具实验；新的AGH多视图任务/插件/UI接线正在实施，尚不能把O字环的native证据称为人物生成的AGH证据 |
| 提交材料 | 最新规则和现有证据保存；暂缺的公开视频、公开内容和成员确认等按用户要求最后补齐 |

本次稳定源码检查点为`34e2941`，此前新鲜全工程97条Node测试、5条提取器、5条Hunyuan helper及10条下载器测试通过；源代码/配置模板已本地提交，Key、私有图像、模型权重和AGH数据库未提交。当前有新的多视图接线未完成代码，不能将这些旧测试数量套到新代码上。独立浏览器导入QA及M3任务恢复/下载/390px布局均通过，未重复启动AGH。

## 新增可复核证据

- `docs/planar-validation-2026-10-02.md`、`data/print-validation/planar-cases/results.json`
- `docs/material-validation-2026-10-02.md`、`data/material-validation-v2/comparison.json`、`independent-preservation.json`
- `data/qa-model-import.json`、`data/qa-model-import-desktop.png`、`data/qa-model-import-mobile.png`
- `data/print-validation/agnes-m3-native-evidence-2026-10-02.json`、`data/qa-print-detail-e886dcdc.json`
- `data/reconstruction/generated/user-character-guide-cleaned-octree256/`、`user-character-actual-slice-report.json`

以上data目录为本地证据，部分包含用户私有输入，不直接放入公开源码或提交包。导出时需使用去敏白名单，不能公开AGH私有数据库、任何Key、任务访问令牌或未经授权素材。
