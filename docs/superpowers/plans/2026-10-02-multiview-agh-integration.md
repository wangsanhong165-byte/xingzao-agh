# 多视图生成接入 AGH 的第一版

## 目标与边界

按已确认的总体方案继续，不新增硬件、纹理训练或任意物品功能模拟。将已实测的Hunyuan3D-2mv本地形状生成接入同一AGH底座：三张用户标注的正/左/背视图 → Agnes通过AGH选择有界生成参数 → 本地专业模型生成 → 独立网格检查 → 实际虚拟切片 → 确认有效资产与运行证据。

首版交付可检验三维资产和切片基线，不宣称最佳打印方案、实物可打印、重建精确或曲面细节保护完成。已验证的平面细节保护流程保留独立入口。输入图需背景简单或已处理，3张PNG/JPEG每张≤5MiB、≤12M像素；目标最长边由用户手动指定1～180mm。

## 结构与冻结接口

- `src/reconstruction-jobs.mjs`：任务状态、图像持久化、候选归属、实际引擎调用/检查/切片/提交门禁和去敏公开状态。
- `src/reconstruction-http.mjs`：路由、图片/STL下载、失败与边界处理；root接到4337现有服务。
- `src/reconstruction-agh.mjs` + `reconstruction-agh-plugin/`：独立5个mesh工具、项目隔离profile绑定及执行记录；保留原detail插件不改版本。
- `public/reconstruct.html/js/css`：三视图输入、真实状态/指标/失败与STL模型预览。

工具：`mesh_inspect`、`mesh_generate`、`mesh_validate`、`mesh_slice`、`mesh_submit`。任务绑定沿用现有PRINT_TASK_JOB_ID/SERVICE_URL/JOB_ACCESS进程环境，但新插件仅访问固定4337 `/api/reconstruction/tool/<tool>`；图像/Key不进入模型上下文。source=agh的实际业务调用才算AGH执行。

HTTP：

- POST `/api/reconstruction/start`：`{views:{front,left,back},targetLongestEdgeMm}`，view为`{name,mime,dataBase64}`，返回`{id,stage}`。
- GET `/api/reconstruction/status`：配置与本地引擎是否存在；存在不能代替实际运行。
- GET `/api/reconstruction/jobs/<uuid>`：`{id,stage,agentRunActive,events,execution,error,submittedCandidateId,views:{front,left,back:{name,url}},candidates:[...]}`。候选含candidateId、generation摘要、geometryChecks、metrics、slice摘要、stlUrl；绝无Key/token/base64/私有文件路径。
- GET `/api/reconstruction/jobs/<uuid>/view/<front|left|back>`与`/stl/<64hex候选ID>`：归属与SHA校验后读取固定文件。
- POST `/api/reconstruction/tool/<inspect|generate|validate|slice|submit>`：同现有令牌与active-job门禁，最多12调用；body`{jobId,options?,candidateId?}`。

生成CLI为`tools/reconstruction/generate_hunyuan_multiview.py`，使用已验证隔离Python。默认25步/256/8000 chunks，同一job最多两次生成；steps5～50、resolution128/256、chunks4000/8000/20000、seed32bit。输出路径以服务生成的run-id确定，禁止任意输出路径或shell。生成器为共享GPU单并发，整体有超时；正常最多600秒AGH任务，工具生成HTTP/执行timeout需覆盖本地加载、生成、简化时间，保持有界。

候选保留raw、Z-up转换和简化记录。独立导入器读取实际STL、检查最长边/封闭/面方向/退化/边界/非流形，失效不提交。实际切片必须mode=actual-slicer；支持关闭的基线报告bridge/overhang，不能假称物理验证。新流程不挪用旧O字环的AGH记录作为人物模型执行记录。

## 连续实施顺序

- [x] 先保存当前已验证M1/M2/M3源码检查点`34e2941`（不发布、不合并旧工作区）。
- [x] backend：先用真实STL+模拟生成器验证归属/序列/sha/错误；再接固定本地CLI。
- [x] harness/plugin：补bounded task/command/secret隔离测试；安装已审包并明确profile引用，离线工具目录探针先证实可见再跑模型。
- [x] UI：分离上传标注/公开状态/模型预览；加载原图和真实候选，不用缓存冒充运行。
- [x] root集成：相关测试与browser QA通过，现有用户三视图真实AGH+Hunyuan+检查+切片闭环完成；此前中断、路径失败、低采样退化记录保留。普通实拍及更广泛案例仍须另行测试。

成员任务以文件边界并行，root负责HTTP接线和总体验收。大体积模型、私有图像和AGH数据库继续忽略，不进入公开源码。已有20余项真实与受控结果仍保留，新增结果按实际来源标注。
