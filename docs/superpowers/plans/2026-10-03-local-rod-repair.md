# 单根细杆受限修正实现计划

> 使用 subagent-driven-development 分工执行，root 集成、真实工具实验和审查。此前用户已授权实施与委派。

**目标：** 从现有失败的源网格生成有预算证明的增厚候选，由 AGH 决策并重新验证后交付。

**架构：** 独立几何算子、独立 repair job、独立原生插件；复用已有源验证、姿态切片与关键特征审计。旧网格和证据保持原样。

**技术栈：** Node 24、现有隔离 Python / Trimesh / Manifold3D 3.2.1、PrusaSlicer 2.9.6、AGH 与 V4.1。

## 任务与文件

- [x] 几何模块：新增 `tools/reconstruction/local_rod_repair.py` 和 `test_local_rod_repair.py`。实现 `inspect_rod(mesh, spec)`、`repair_rod(mesh,spec,radius_mm)`、`verify_rod_repair(source,candidate,spec,radius_mm)`，CLI 固定 data 请求目录，模式 inspect/apply/verify。测试真实网格并集、未修改区、预算、弯杆/邻件/篡改/路径越界反例。运行 `python -m pytest tools/reconstruction/test_local_rod_repair.py -q`，新测试先失败再实现。
- [x] CPU 服务：新增 `src/local-repair-service.mjs` 及测试；固定 Python、受限路径、90 秒超时、源码/源/参数/结果 SHA、fresh 独立复查。调用实际几何模块，拒绝伪造或更改预算。
- [x] 状态与评价：新增 `src/repair-jobs.mjs` / `.test.mjs`、`src/repair-http.mjs`。父任务只能从服务加载，检查已经结束且目标特征失败；冻结声明、预算和姿态。以候选 `original` 和任务生成的 `r01`～`r03` 标识运行相同真实切片；原源与候选特征双重检查，最多三次修正；未通过不能 verify/submit。
- [x] 原生底座：新增 `repair-agh-plugin/{package.json,index.mjs,README.md}`、`src/repair-agh.mjs`、对应原生工具/runner 测试、`tools/setup-repair-agh.mjs`。五工具 inspect/evaluate/apply/verify/submit；模型读取当前已审配置，nonce 保持本机任务边界。新包通过官方 inspect/install/trust/enable/pin 注册，不改变旧插件。
- [x] 页面：新增 `public/repair.html` / `.css` / `.js`，在姿态页面提供接续入口，挂载服务。明确声明坐标、有限候选、预算与虚拟验证范围；对比真实 STL，展示失败原因；恢复页面零自动提交。
- [x] 真实实验：先从 `f21461b7-3e2c-4824-bd94-63af6a7fe7bf` 的 upright 源开始，确认 `[5,0,3]→[5,0,5]`、允许范围 `[[4.5,-0.5,3],[5.5,0.5,5]]`、最大径向增加 0.2 mm、新增体积上限 2 mm³。单独测试半径 0.30/0.35/0.40 mm；保留失败并证明不是重生成预制测试件。随后由真实 V4.1/AGH 完成正常与小预算停止流程，核对原生账本和服务事件。
- [x] 审查与交付：核对全部几何与阈值证明、运行适配的 Node/Python 回归、桌面/手机页面与实际上传/下载，检查密钥和私有素材不进入提交；保存隔离分支检查点与下一阶段事项。

## 核心通过规则

`feasible = geometryProof.verified && originalFeatureAudit.verified && originalFeatureAudit.passed && candidateFeatureAudit.verified && candidateFeatureAudit.passed && sameSourcePoseProfile`。

`submitAllowed = selectedCandidateId === recheck.candidateId && candidateSha256 === recheck.candidateSha256 && recheck.verified`。

source / params / helper / output / profile / G-code 任何 SHA 或不可变声明不一致时拒绝；原候选与子候选始终分别归档。
