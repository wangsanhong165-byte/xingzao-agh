# 集成标准

[English](integration.md) | 简体中文 · [项目首页](../README.zh-CN.md)

本文说明**当前已实现的本地集成约定**，不另立行业协议，覆盖 AGH 插件、HTTP 调用、文件格式和可复现执行。

## 1. 运行时兼容

| 组件 | 项目约定 |
| --- | --- |
| 工作台 | Node.js 24.10+、ECMAScript模块、本机 HTTP `http://127.0.0.1:4337/` |
| AGH | 基础提交 `ec7ebbdb36e7658d2a121c3ba5113e850b16cb63` 加[项目适配](../agh-adaptation/README.md) |
| 插件 | `package.json` 的 `agnes.plugins` 描述；通过 `apply(ctx)` 中的 `ctx.extension().registerTool()` 注册工具 |
| 工具参数 | 带 TypeBox kind 标记的 JSON Schema 风格对象，声明字段并设置 `additionalProperties: false` |
| Python工作进程 | Python 3.12；几何/形状与上色使用独立环境 |
| 切片器 | PrusaSlicer 2.9.6，配置位于 [tools/slicer](../tools/slicer) |

构建和安装见[完整配置](../运行与模型配置.md)。安装脚本基于固定运行时完成4个业务插件的安装、信任、启用和快照固定；更换 AGH 版本需另行验证。

## 2. AGH工具与执行顺序

| 插件包 | 工具名称 | 必须遵循的顺序 |
| --- | --- | --- |
| [reconstruction-agh-plugin](../reconstruction-agh-plugin/index.mjs) | `mesh_inspect`、`mesh_generate`、`mesh_validate`、`mesh_slice`、`mesh_submit` | 检查 → 生成 → 验证网格 → 实际切片 → 提交 |
| [texture-agh-plugin](../texture-agh-plugin/index.mjs) | `texture_inspect`、`texture_generate`、`texture_verify`、`texture_submit` | 检查 → 生成 → 验证对应尝试 → 提交 |
| [pose-agh-plugin](../pose-agh-plugin/index.mjs) | `pose_inspect`、`pose_evaluate`、`pose_select`、`pose_verify`、`pose_submit` | 检查 → 评估全部声明姿态 → 选取可行推荐 → 复核 → 提交 |
| [repair-agh-plugin](../repair-agh-plugin/index.mjs) | `repair_inspect`、`repair_evaluate`、`repair_apply`、`repair_verify`、`repair_submit` | 检查 → 评估原件 → 失败后采用允许修正 → 评估 → 复核 → 提交 |

修正任务中，原件评估通过可跳过 `repair_apply`，直接验证。工作台采用 `fixed-five-v2` 策略，姿态 ID 为 `upright`、`tilt-x-plus`、`tilt-x-minus`、`tilt-y-plus`、`face-up`。底层姿态API省略 `posePolicy` 时默认使用历史 `fixed-four-v1`，因此调用方需要明确传入 `fixed-five-v2` 才会比较5种姿态。修正候选为 `original` 和服务依次签发的 `r01`～`r03`。纹理尝试为 `t01`/`t02`；只有标准配置发生真实资源失败后才允许使用 `compact` 配置。

生成次数、修正候选和工具调用均有会话预算。客户端使用服务返回的候选和选项，不自行编造 ID、无限重试或绕过复核。

## 3. 本地HTTP接口

| 用途 | 路由 |
| --- | --- |
| 运行状态 | `GET /api/{reconstruction,texture,poses,repair}/status`，选择其中1个模块名 |
| 创建任务 | `POST /api/{module}/start`，提交该模块验证器要求的输入 |
| 读取任务 | `GET /api/{module}/jobs/{jobId}` |
| 重建工具 | `POST /api/reconstruction/tool/{inspect,generate,validate,slice,submit}` |
| 上色工具 | `POST /api/texture/tool/{inspect,generate,verify,submit}` |
| 姿态工具 | `POST /api/poses/tool/{inspect,evaluate,select,verify,submit}` |
| 修正工具 | `POST /api/repair/tool/{inspect,evaluate,apply,verify,submit}` |

表中花括号表示可选值或占位符，不是实际 URL。使用浏览器工作台创建任务、确认选取区域。创建请求返回 HTTP **202** 及 `{ "id": "…", "stage": "…" }`，随后读取对应任务接口。各模块输入不同，以[重建任务](../src/reconstruction-jobs.mjs)、[上色任务](../src/texture-jobs.mjs)、[姿态任务](../src/pose-jobs.mjs)、[修正任务](../src/repair-jobs.mjs)中的验证器为准。

工具调用使用 UTF-8 JSON、`Content-Type: application/json`、请求体 `jobId` 及 **`X-Print-Task-Access`** 请求头。任务必须有正在执行的 AGH 流程，且令牌匹配。令牌由运行器注入，用户不需要手动填写，也不能从公开轨迹复制后使用：

| 插件 | 运行器注入的环境变量 |
| --- | --- |
| 重建、姿态、修正 | `PRINT_TASK_JOB_ID`、`PRINT_TASK_JOB_ACCESS`；重建还接受经验证的 `PRINT_TASK_SERVICE_URL` |
| 上色 | `PHOTO_CAD_TASK_ID`、`PHOTO_CAD_ACCESS_TOKEN`、`PHOTO_CAD_SERVICE_URL` |

以下示例用于已经获得当前任务权限的适配器：

```javascript
async function inspectPose(jobId, accessToken) {
  const response = await fetch('http://127.0.0.1:4337/api/poses/tool/inspect', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Print-Task-Access': accessToken,
    },
    body: JSON.stringify({ jobId }),
  });
  const result = await response.json();
  if (!response.ok || result.success !== true) {
    throw new Error(result.reason ?? result.code ?? result.error ?? `HTTP ${response.status}`);
  }
  return result;
}
```

HTTP 成功不等于候选可行，还需按操作检查 `success`、`feasible`、`valid`、验证和交付字段。例如，姿态任务访问失败返回 HTTP 403、`success: false`、`code: "POSE_TASK_ACCESS_DENIED"`；姿态下载哈希过期返回 HTTP 409、`error: "POSE_STALE_SHA"`。其他模块有各自错误码。

状态查询不需要任务令牌：

```powershell
Invoke-RestMethod http://127.0.0.1:4337/api/poses/status
```

### 示例：导入标准STL并创建五姿态任务

完成CPU和AGH配置后，在仓库根目录运行。导入模型需要CPU工具，启动任务另需已配置的本人AGH模型账号。公开的创建入口无需手动传工具令牌，由运行器内部生成。

```powershell
$file = (Resolve-Path 'case/source-original.stl').Path
$payload = @{
  name = 'source-original.stl'
  mime = 'model/stl'
  sourceUnits = 'mm'
  targetLongestEdgeMm = 30
  dataBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($file))
} | ConvertTo-Json -Depth 6
$model = Invoke-RestMethod http://127.0.0.1:4337/api/model-import -Method Post -ContentType 'application/json' -Body $payload
$poseRequest = @{
  sourceKind = 'imported'
  sourceCandidateId = $model.candidateId
  posePolicy = 'fixed-five-v2'
} | ConvertTo-Json
$job = Invoke-RestMethod http://127.0.0.1:4337/api/poses/start -Method Post -ContentType 'application/json' -Body $poseRequest
Invoke-RestMethod "http://127.0.0.1:4337/api/poses/jobs/$($job.id)"
```

最小示例没有声明保护区域或细杆，因此**不包含这些特征检查**。请用工作台选取并确认杆段/区域，或按验证器补充 `criticalFeatures`、`continuousRods`、`protectedRegions`/`maxRegionSupportPathLengthMm`。随后轮询返回的任务ID；只有 `stage: "completed"` 且 `recheck` 成功才是验证后交付，`no-feasible`、`failed`、`interrupted` 都是停止结果。下载使用任务返回的STL/G-code链接，不自行拼接文件哈希。

## 4. 文件与测量约定

| 项目 | 约定 |
| --- | --- |
| 几何 | STL 用于制造；GLB/glTF二进制用于带纹理审阅；STL不保留颜色 |
| 尺寸 | 用户明确确认尺度后使用毫米；STL本身没有可靠单位元数据 |
| 坐标 | 区分源坐标、打印变换与热床偏移，使用记录的变换比较同一区域 |
| 刀轨 | 固定切片器与配置生成的 G-code；从切片注释识别模型/支撑角色 |
| 覆盖 | 只使用正向模型挤出，支撑与空移不计入模型覆盖 |
| 未支持路径 | 圆弧挤出不纳入线段检查；随仓库复核会拒绝未支持的圆弧挤出 |
| 文件身份 | 用 SHA-256 绑定源模型、候选、配置和输出；下载使用任务返回的准确 URL及哈希 |
| 记录 | 任务 JSON/事件和 AGH 界面导出；原始导出位于 [evidence/agh](../evidence/agh) |

解析器处理定位/挤出状态 `G90/G91`、`M82/M83`、`G92` 和单位转换 `G20/G21`。支持方言见 [slicer.mjs](../src/slicer.mjs)。更换切片器或配置时，先验证解析、角色与放置关系，再比较结果。

## 5. 扩展方式

1. 增加具有输入校验、明确单位、有限候选和可检查输出的服务操作。
2. 用 AGH 插件暴露参数边界明确的工具，沿用当前任务的 HTTP 绑定。
3. 将反馈写入任务状态，在交付前执行复核，保留原始源模型身份。
4. 用代表性输入、应拒绝输入和一次实际工具执行验证，区分文件复核与新任务。

服务绑定本机地址。本版本集成软件工具，未实现 MHS/打印机硬件控制或公共托管 API。
