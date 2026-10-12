# 形造：照片建模与打印验证工作台

以 Agnes Harness（AGH）执行照片/模型输入、工具调用、实际切片、受约束修正与交付复核。当前运行模型为 CommandCode 的 `deepseek/deepseek-v4.1-flash`；专业三视图几何生成使用本地 `tencent/Hunyuan3D-2mv`。实物打印和机械性能仍需另行测试。

模型按赛事工作人员“底座为 AGH、模型不固定”的答复使用，实际名称和版本分别申报。官网部分旧条文仍与开放模型条文不一致，见 [10月7日提交准备](docs/submission-readiness-2026-10-07.md)。历史 Agnes 3.0 Flash 运行不能挪作当前 V4.1 任务的模型参与证明。

## 运行与审阅

需要 Node.js **24.10 或更高**。从源码或复核包解压目录执行：

```powershell
npm.cmd ci
npm.cmd run start:print
```

本机开发工作树为 `D:\黑客松\photo-cad\.worktrees\agh-print-detail`。主工作台使用 `http://127.0.0.1:4337/`，只供本机访问，不是异地评委体验链接。端口占用时先核对进程，不终止不明服务。

| 页面 | 当前范围 |
| --- | --- |
| `/` | 制作工作台，串联照片建模、外观保护与细杆检查，显示实际任务回执 |
| `/workflow` | 已验证模型点选直杆，确认预算后一次完成原生AGH姿态检查、必要修正、独立复核与交付；可按URL恢复任务 |
| `/reconstruct` | 正/侧/背三张图 → Hunyuan形状候选 → 网格检查 → 实际切片基线 |
| 重建侧视方向 | 可明确选择侧脸朝左或朝右，映射到模型原生方向；图片与方向同时绑定 |
| `/protect` | 在源模型上点选重要表面、调整保护体积，按同源基线和预先确认的降幅比较五姿态，复核后交付 |
| `/poses` | 同一网格和自动支撑配置下，按任务声明比较姿态与保护约束；高级入口默认四项，新工作流五项 |
| `/repair` | 对失败实体点选测量、确认预算，再由AGH生成和复核直圆杆修正 |
| `/texture` | 插画彩色预览；UV尺度塌缩已修正并验证三组人物，几何保持独立复核，细节/接缝仍需审阅 |
| `/case` | 关联本机已完成的重建、上色和外观保护任务，复核同源与实际文件后展示比较和下载；无本地案例记录时明确提示 |
| `/print-detail.html` | 平面细节工具验证与历史样例 |

正式工作台可由“启动.bat”、`npm.cmd start`或`npm.cmd run start:print`启动，默认4337端口。已有结果可通过“复核已有结果.bat”核对；完整环境和模型获取步骤见[运行与模型配置](运行与模型配置.md)，AGH本地适配源码位于[agh-adaptation](agh-adaptation/README.md)。

审核人员可先打开提交包根目录的“复核报告.html”。双击“复核已有结果.bat”会重新核对真实样例并打开中文报告，按案例列出预期、实际结果、耗材和时间估算。原始核验数据折叠在报告底部；命令行添加`--details`可查看完整技术输出，底层验证规则保持不变。

旧照片辅助原型由 `npm.cmd run start:photo` 在4317端口启动，支持有限板件、支架和盒体；不能描述为任意实物CAD重建。

首次进入制作工作台选择任务；重建完成页可携带来源进入外观保护或细杆检查。外观保护先计算真实直立切片基线，按确认的降低比例冻结支撑上限和源坐标保护体积，再由AGH组织五姿态比较。调整模型、保护框或目标会清除旧确认，恢复URL只读取现有任务。统计的是保护体积内计划支撑刀轨长度，不能替代支撑接触面损伤实测。

自己的STL/GLB先通过`/poses?mode=import`的文件检查，再点击继续入口进入外观保护或细杆检查，后续页面自动选择已验证源。导入本身不启动AGH任务。

外观保护的启动响应丢失时，页面通过冻结提案GET找回原任务；刷新保留恢复入口，不自动重复启动。未启动的提案需再次确认，服务中断的任务有明确终止状态。结果同时列出区域支撑收益与总耗材/时间代价。第二个真实照片候选和过高目标停止案例见[恢复与真实样例验收](docs/protection-recovery-validation-2026-10-09.md)。

细杆点选支持单根轴对齐直圆杆，原特征保护范围与允许增长范围分别显示；所选原杆和修正件均受中心线连续性检查。新任务评估五个固定姿态，含X−90°侧放；历史四项记录仍按原合同读取。原件可行则不改几何，已知目标路径缺失且预算允许才进入修正，未知/其他失败或固定半径配方无候选则停止。其他未申报特征不作切片级保证，候选比较不是全局最优。

运行依赖分层，只读预检命令如下：

```powershell
node tools/review/preflight.mjs --mode offline
node --env-file-if-exists=.env tools/review/preflight.mjs --mode live
node --env-file-if-exists=.env tools/review/preflight.mjs --mode shape
```

离线网格/切片预检需要CPU网格环境和PrusaSlicer；AGH模式检查状态接口；形状模式只报告生成器配置与资产是否齐全，不代替一次GPU推理。见 [预检说明](docs/review-preflight-2026-10-07.md)。

### 轻量证据复核包

包内包含来源固定的网格、真实G-code、缓存探针、三类案例索引、脱敏原生执行摘要和源代码。解压后在目录内直接执行：

```powershell
node tools/review/check.mjs --bundle .
```

该命令不需要Key、GPU或npm安装，重新核对文件、刚性位姿、切片刀轨和预算选项。它使用包内缓存网格探针，不是重新执行AGH、重新生成探针或验证实物。见 [缓存复核说明](docs/review-cached-check-2026-10-07.md)。

开发者从已去敏的本机快照打包：

```powershell
node tools/review/bundle.mjs --snapshot data/review-evidence-20261007/snapshot.json
```

快照引用本机证据，不随源码自动产生。构建器只复制允许的源码与明确列出的文件，不带入.env、凭据、数据库、环境或大权重。该复核包还需要视频、公开内容和真实成员材料才构成完整赛事提交。

## 已验证的范围

完整灯柱案例是原创参数化设计，12×8×30mm，包含26mm细杆与通孔，不是照片重建。原0.5mm直立及先测四姿态未达申报要求，AGH在预算内修正；0.7mm虽通过表面采样，仍因断段被拒，0.8mm通过交付复检。补充的合理强基线原件-90°放平也通过，0.80g/346秒；修正直立为0.69g/557秒，少约13.75%总材料但更慢。不宣称必须加粗或强度等价。见 [今日实拍与强基线](docs/photo-and-baseline-validation-2026-10-07.md)、[历史完整模型验证](docs/complete-object-validation-2026-10-05.md) 与 [点击选杆验收](docs/visual-rod-selection-validation-2026-10-05.md)。

拟合限于源坐标系中轴对齐的单一直圆杆；曲杆、空心管、多截面或超限几何会被拒绝。高级母姿态页需声明特征区域；首次委托通过点选生成待确认提案。正式交付复查候选身份、源/候选哈希、配置、预算与验证；失败候选可检视，不能从正式入口放行。10月8日五项真实委托保留0.5mm原杆，以侧放直接交付0.80g/346秒，不进入加粗；小径向预算亦可交付原件。见[五姿态验收](docs/five-pose-validation-2026-10-08.md)。

实拍与人物输入保留成功和失败结果：骰子流程完成但点窝还原未通过，人物头发专项暂停。10月7日新实拍展示模型按预定外观条件独立检查，制造保护结果另列。轮廓IoU不是三维真值、尺寸精度或语义还原率；相机未标定时明确说明，不能与受控CAD真值混用。

10月9日通过网页创建真实照片来源的外观保护任务，预先要求保护区计划支撑至少降低50%。同源、同ROI、同尺寸和配置下，AGH比较五姿态后降低77.33%，切片估算总耗材39.01g→33.81g、时间10,908秒→9,333秒；原有零支撑失败记录保留。复杂单体的远处轮廓和300层竖壁已不再误阻断局部选杆，空心内壁和增长区障碍仍被拒；新版几何工具独立保存，历史收据继续使用原字节复核。真实任务、下载指纹和回归详见[产品补齐验收](docs/product-gap-validation-2026-10-09.md)。

同日用用户三张高清角色图实际运行三组形状与插画上色：处理右视方向，并定位100mm米单位网格在UV计算中大面积塌缩。UV工作副本归一化、原坐标映射和塌缩守护加入后，三组完整AGH上色复跑通过，配色恢复，源三角几何保持；原坏结果和接口传输失败保留。详见[三组角色与UV尺度验收](docs/user-character-validation-2026-10-09.md)。

本版产品范围已收敛，完整本机角色案例串联同源输入、颜色审阅、保护范围调整、五姿态切片和文件交付，详见[产品验收与停止范围](docs/product-closure-2026-10-09.md)。精细发丝和面部的无收益实验已停止。私人角色输入与本机任务数据库不随源码分发；可从工作台使用自己的图片或模型建立任务，随包公开许可样例和缓存刀轨供独立复核。

## 环境与凭据

- 网格导入可用PHOTO_CAD_MESH_PYTHON指定CPU Python；其他生产工具默认使用data/reconstruction/env-torch-readonly/Scripts/python.exe，部署时按工具说明准备该路径。
- 本机形状环境继承D:\conda\envs\qwen3-asr，仅在独立子环境增加依赖，不删改或升级父环境。实际包版本由预检取得，旧requirements.txt不代表所有运行环境。
- 固定模型revision、源码和权重hash的获取及许可见 [重建说明](tools/reconstruction/README.md)。本应用GPU租约保证重建与上色不同时运行。
- Key与AGH凭据库保持私有，不进入浏览器、源码、截图和复核包。配置见各*-agh-plugin与tools/setup-*-agh.mjs。尚未完成异地干净机器的完整推理安装验收。

## 验证与来源

```powershell
npm.cmd test
node --test tools/review/*.test.mjs
data/reconstruction/env-torch-readonly/Scripts/python.exe -m pytest tools/reconstruction/test_rod_target_proposal.py tools/reconstruction/test_compare_shape_silhouettes.py -q
```

局部几何新版回归：

```powershell
data/reconstruction/env-torch-readonly/Scripts/python.exe -B -m pytest tools/reconstruction/test_rod_target_proposal.py tools/reconstruction/test_rod_proposal_complex.py tools/reconstruction/test_local_rod_repair.py tools/reconstruction/test_local_rod_repair_v2.py -q
```

单测含协议注入与合成反例，真实运行证据另列。新增透明渲染遮罩避免将暗色眼窝误报为轮廓缺失；旧蓝色阈值报告保留原记录。

主要第三方为[AGH](https://github.com/AgnesAI-Labs/agnes-harness)、[Tencent Hunyuan3D-2](https://github.com/Tencent-Hunyuan/Hunyuan3D-2)、[PrusaSlicer](https://github.com/prusa3d/PrusaSlicer)、[JSCAD](https://github.com/jscad/OpenJSCAD.org)、[Three.js](https://github.com/mrdoob/three.js)、[Blender](https://www.blender.org/)、OpenCV、NumPy、Trimesh、Rtree与Manifold3D，依各自许可证获取和使用。公开实拍采用alansartlog的[CC BY 4.0摄影数据](https://github.com/AlansCodeLog/photogrammetry-test-sets)，具体图号、仓库提交、原/衍生哈希与裁切记录随样例提供，用户私人图片不自动公开。
