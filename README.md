# 形造：照片建模与 3D 打印验证助手

把图片建模、彩色审阅和制造验证放进同一工作台。Agnes Harness（AGH）负责理解要求、规划任务、调用工具、读取执行反馈、调整纠错和验证交付，专业生成器与切片器提供可检查的结果。

## 演示

[观看演示视频（4 分 21 秒，1440p）](demo/xingzao-demo.mp4)

![工作台与验证流程](demo/cover.png)

## 主要能力

- 正、侧、背视图生成三维形状，既有网格生成彩色审阅版本。
- 点选重要外观区域，在固定模型、尺寸和切片配置下比较五种摆放，并同时显示区域支撑、总耗材与时间代价。
- 细杆检查优先保留原模型；姿态无法满足要求时，在确认的几何和材料预算内局部修正，再检查刀轨连续性。
- 保留未达目标的停止结果、任务恢复与原生执行记录，交付前核对模型、配置和文件身份。

公开摄影案例的保护区计划支撑刀轨长度降低 **77.33%**，切片估算材料 **39.01 g → 33.81 g**、时间 **10908 s → 9333 s**。原创灯柱的 0.5 mm 细杆通过五姿态比较，以原件侧放交付，估算 **0.80 g / 346 s**。历史修正案例保留了 0.7 mm 断段被拒、0.8 mm 通过的反馈过程。

当前以实际 PrusaSlicer 切片和独立程序开展软件验证；实物成型、强度和装配测试列为后续工作。

## 无 Key、无 GPU 复核

需要 Node.js 24.10 或更高。在仓库根目录运行：

```powershell
node tools/review/check.mjs --bundle .
node examples/photo-protection/复核支撑.mjs
```

第一条重新核对五个已有案例的文件、位姿、缓存网格探针、实际刀轨和预算；第二条独立复算公开摄影案例的区域支撑结果。这里使用已有产物，不重新执行生成模型。

## 启动应用

```powershell
npm.cmd ci
npm.cmd run start:print
```

打开 http://127.0.0.1:4337/ 。完整建模、上色和 AGH 执行还需按[运行与验证说明](docs/project-runtime-guide.md)、[模型取得说明](tools/reconstruction/README.md)配置依赖和自己的账号。仓库提供源码、锁定依赖、公开许可样例及复核记录，不附凭据、模型权重、Python 环境或私人任务数据库。

## 技术和来源

核心底座：[Agnes Harness](https://github.com/AgnesAI-Labs/agnes-harness)；任务模型：DeepSeek V4.1 Flash；形状与颜色：[Tencent Hunyuan3D-2](https://github.com/Tencent-Hunyuan/Hunyuan3D-2) 的 2mv / Paint Turbo；制造反馈：[PrusaSlicer](https://github.com/prusa3d/PrusaSlicer)。渲染与几何使用 Three.js、JSCAD、Blender、Trimesh 等工具。依赖和数据保持原有许可，详见各工具说明及样例署名记录。

公开摄影数据来自 alansartlog 的 [CC BY 4.0 摄影数据集](https://github.com/AlansCodeLog/photogrammetry-test-sets)，文件身份、裁切和署名随案例保存。灯柱是原创参数化设计。视频中的角色演示用于展示实际生成效果，角色原图、私人资产和语音模型不随源码发布；视频旁白使用本地 GPT-SoVITS 穹声线。

功能源码来源版本：`562483953615a36ce6e3fad3a1df124fe6a267f6`。公开快照新增本说明、演示视频和公开摄影复核入口，保留各历史任务原本的日期与策略。
