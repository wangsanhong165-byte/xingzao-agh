# 已验证 UV 纹理接入 AGH 与重建页面

> 面向 AI 代理：使用 subagent-driven-development 按下列文件边界实现，root 集成和实际验收。用户已批准继续完善现有流程，不重复询问该实现的许可。

目标：从已完成的重建任务进入独立彩色预览任务，经真实 AGH inspect → generate → verify → submit 形成持久化证据，可恢复页面、查看白模/颜色和下载已复核 GLB。

架构：重建与制造任务保持现有语义。新增 texture 任务绑定父重建已提交候选及正面图片 SHA；Python worker 将同一 STL 的 Z-up/mm 明确转换成 glTF Y-up/metres，调用现有真实 Paint CLI，禁止简化或改形。新原生插件只有四项纹理工具，V4.1 负责调用和基于实际资源失败的有限降级。

技术栈：Node 24 原生 HTTP/store、原生 AGH package/preset、已隔离 Python/Torch/CUDA/Paint、Three STL/GLTF loader。

## 范围与硬约束

- 仅支持已声明为平面插画的参考（referenceKind=flat-illustration），此轮不下载 Delight、不接新云模型。
- 不修改父网格、制造方案或旧任务记录。输入 ≤25MiB、≤250000 面；没有隐式 QEM 降面。
- 固定 profile standard：render1024/atlas2048/views6；compact：512/1024/4。compact 仅在 standard 有真实资源失败之后允许，最多2次生成。
- 纹理完成、几何保护和 GLB 有材质/UV/内嵌图像分别检验；不声称视觉合格、最佳纹理或物理打印。
- Agent 不获得路径、shell、上传能力或任意参数。HTTP 工具调用沿用任务 token，工具和文件读取必须重新核对绑定 SHA。
- 只有 verify+submit 且任务完成，公开纹理下载 URL；失败/未核验结果不交付。白模始终可从原重建页面查看。
- HTTP 恢复不启动新模型请求；跨候选/换源/文件变更/输入图片变更应拒绝。

## 稳定 HTTP/UI 合同

GET /api/texture/status → {ready,model,engineAvailable,scope:"flat-illustration-existing-stl"}。

GET /api/texture/parent/:sourceJobId → {sourceJobId,candidateId,sourceSha256,sourceStlUrl,dimensionsMm,reference:{url,sha256,label},scope}。父任务必须 completed 且候选已提交并经过实际切片。

POST /api/texture/start body {sourceJobId,referenceKind:"flat-illustration"} → 202 {id,stage}。新任务不重建原白模。

POST /api/texture/tool/(inspect|generate|verify|submit)，header x-print-task-access；body {jobId,attemptId?,profile?}。generate 仅 profile，不得输入路径。attemptId=t01/t02。

GET /api/texture/jobs/:id → {id,sourceJobId,stage,agentRunActive,error,execution,events,source:{candidateId,sha256,stlUrl,dimensionsMm},reference:{url,sha256,label},attempts:[{attemptId,profile,status,errorCode,metrics:{faces,textureSizePixels,geometryPreservedAtFloat32,peakAllocatedGpuMiB,elapsedSeconds},glbSha256,glbUrl}],submittedAttemptId}。events 为现有通用 {tool,source,success,code,message,at}。未提交时 glbUrl=null。

GET /api/texture/jobs/:id/glb/:attemptId?sha=<64hex> → model/gltf-binary，只提供交付候选、核对所有来源/文件 SHA，旧 SHA=409。

页面 /texture?source=<parentUUID> 供创建，/texture?job=<UUID> 供恢复。白模源 Z-up/mm；GLB 文件 Y-up/metres，在当前 Three Z-up/mm 场景中 rotation.x=π/2、scale=1000，只作显示变换，保持界面比较对应。

## Python worker 合同（独立模块边界）

tools/reconstruction/texture_worker.py --request <JSON>。
请求 mode=generate|verify，jobId、attemptId、profile、sourceStlPath、sourceSha256、referenceImagePath、referenceSha256、outputDir。所有文件/输出限当前根 data/texture/jobs/<UUID>，outputDir 固定 t01/t02；拒绝路径越界/链接、长度/hash 不符、重复输出、错 profile。

generate 将原 STL 导入，允许合并重复顶点但不改变有向三角坐标，映射 [x,z,-y]/1000 到 Y-up/metres，保存预处理副本。调用 run_texture_probe.py（runId=texture-<UUID>-t01/t02，输出按既有 CLI 在 data/texture-experiments 下），真实生成；复制 textured.glb/atlas.png 到本次 outputDir，写 result.json。严禁从其他实验目录预取成功模型。NN 模块在同一 worker 进程运行，避免启动另一个无法被管理的 GPU 子进程；Python处理入口须考虑 Windows venv launcher 的父进程终止，不能只声称超时已清理。

stdout 输出单个结果 JSON：{success,code,attemptId,profile,sourceSha256,referenceSha256,glbSha256,glbBytes,metrics:{faces,textureSizePixels,geometryPreservedAtFloat32,peakAllocatedGpuMiB,elapsedSeconds},proof:{inputGeometrySignature,outputGeometrySignature,coordinateTransform:"Z-up mm to Y-up metres [x,z,-y]/1000",modelRevision,sourceRevision}}。过程日志写本次目录（不含 API 密钥）。失败 code 仅固定枚举：TEXTURE_GPU_BUSY / TEXTURE_RESOURCE_FAILURE / TEXTURE_ENGINE_FAILURE / TEXTURE_SOURCE_CHANGED / TEXTURE_RESULT_INVALID / TEXTURE_INPUT_INVALID。

verify 独立重读 source/ref/output 与 result.json，重建原 STL→Y-up/metres 的签名，检查导出 GLB 签名相等、facecount、实际 UV 和可解码图像（对应 profile 尺寸）、SHA、固定 model/source revision、禁止外部 glTF URL。不信任布尔 geometryPreserved 字段，不能仅复读已有报告。

建议把纯检查/坐标功能置 tools/reconstruction/texture_delivery_core.py，可写标准小网格实际测试。没有 GPU 的测试不冒充模型执行证据。

## 任务与验收

### 1. Python worker（Luna，限定文件）
- [x] 先写失败回归：错 hash、移动/翻面、错误坐标转换、缺材质/无 UV/外部 URI、修改结果、path/link边界、profile配置。
- [x] 实现 source 绑定、确定性转换、真实 CLI 调用、独立 verify 和安全失败。
- [x] 使用 env-texture-probe 运行 CPU 测试；不自行启动 GPU、不安装依赖、不改 CLI/全局环境。

### 2. 页面（Luna，限定文件）
- [x] 新 texture.html/js/css，采用现有样式/导航；从真实合同数据渲染状态和模型。
- [x] source 与 job 参数流程、明确“插画参考”确认、状态轮询、恢复不 POST；失败不给下载。
- [x] GLB 仅加载可信结果 URL；白模/彩色切换、重置/下载、正确坐标、释放 Three 资源。
- [x] 桌面/390px 不溢出；不修改已有 reconstruct 文件/服务器。

### 3. 后端与原生 AGH（root）
- [x] store：不可变来源、状态机、预算、资源降级、持久化中断与 token 轮换、独立交付核验。
- [x] router：body/CORS/token/候选归属与 SHA，读取文件校验。
- [x] texture-agh/plugin/setup：独立 package和preset，保留当前模型/其他已信任包，四 native tools，真实运行日志。
- [x] print-server 接入新 router/static routes；reconstruct 页面添加完成任务的上色入口。
- [x] 测试真实生命周期、错来源/状态/预算/错误交付/HTTP权限等行为。

### 4. 实际链路、审查与证据（root）
- [x] 先 CPU+HTTP 定向检查，再实际 worker 对原重建240k STL运行；CPU/显存问题据实际错误处理，不暗改输入。
- [x] 原生 AGH/V4.1 任务完成并交叉核对 native 工具记录与服务事件。
- [x] 用浏览器真实恢复、预览、下载/字节SHA、白模/彩色、页面尺寸、未交付限制检查。
- [x] 正常、来源/声明边界和至少一次失败/停止证据；不人为伪造模型效果或运行记录。
- [x] 规格审查→质量审查→必要修复；相关回归、差异/密钥扫描、阶段提交。

到此再用完整对象评价制造任务收益；新 D 型孔/卡扣能力不属于这一轮。新增工具链接通与真实用户收益分别报告。

## 2026-10-05 阶段验收结果

四工具原生 AGH、实际 240k Paint、独立几何复核、恢复/下载及正常/源变更失败证据已完成。检查项表示链路检查完成，视觉效果仍未合格：存在灰斑，已标为实验功能。没有真实 GPU 强制取消或实际 OOM compact 降级证据。后续主线按 docs/texture-agh-integration-validation-2026-10-05.md 推进完整对象制造收益。
