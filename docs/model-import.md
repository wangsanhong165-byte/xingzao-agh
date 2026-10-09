# STL / GLB 导入检查

独立导入模块接收用户本机文件，不连接第三方模型、不启动 AGH。允许 STL 或内嵌资源的 GLB 2.0，文件最多25MiB、三角面最多25万、部件最多128个；外部 GLB 资源 URI、压缩网格和未支持的图元会明确拒绝。

目标最长边由用户给定为1～180mm。当前导入模式总是按目标边归一化；`mm` 或 `target-scale` 记录源单位含义，并不会自动推断物理尺寸。GLB节点变换先作用于原场景，再按统一比例缩放并转到XY居中、最低Z=0，保存4×4变换与原始包围盒。

当前工作台按Z向上显示，不自动判断源模型向上轴或最佳打印朝向。特别是GLB/glTF常采用Y向上，应保留原件并显式转换朝向后再用作打印候选，记录转换矩阵；模型可能侧躺并不等同于几何重建失败。朝向优化及对应支撑/成本比较仍是后续核心流程的一部分，当前导入不宣称已完成该步骤。

输出包括尺寸、面数、封闭性、面方向、退化面、边界边和非流形边、体积，以及规范化STL的SHA。`geometryChecksPassed`/兼容字段`printable`仅代表本轮几何检查；明确附带 `validationScope.kind='geometry-only'`。未评估自相交、切片可行性、打印配置、强度或实物打印。

## 独立CPU检查环境

导入检查不需要GPU或Torch。可以在Python3.12环境中独立安装：

```powershell
python -m venv .venv-mesh
.venv-mesh/Scripts/python.exe -m pip install -r requirements-mesh.txt
$env:PHOTO_CAD_MESH_PYTHON = (Resolve-Path .venv-mesh/Scripts/python.exe).Path
npm.cmd run start:print
```

本机验证临时使用 `data/reconstruction/env-torch-readonly`，其复用的父环境未被修改；上述CPU方案用于避免复现者依赖该机器路径。不要将机器的既有语音模型环境当作项目必须依赖。

## API

POST `/api/model-import`：`name`、`mime`、`dataBase64`、`targetLongestEdgeMm`、`sourceUnits`。成功返回检查摘要和固定候选ID的 `stlUrl`，不返回服务器私有文件路径。

GET `/api/model-import/<64hex候选ID>/stl`：校验本机保存的候选和STL SHA，再提供归一化文件。并发检查限一份，任务繁忙返回409；不接受任意工作区文件路径。用户原件与检查结果保存于忽略的 `data/import-jobs`，不能未经授权随公开代码发布。

验证命令：`node --test src/model-import.test.mjs tests/model-import-http.test.mjs`。服务测试验证真实STL解析、下载字节SHA以及异源POST拒绝；浏览器导入STL/GLB与旧任务保持的本机证据另存在 `data/qa-model-import.json`。
