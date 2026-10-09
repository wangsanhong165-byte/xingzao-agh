# 三视图 AGH 闭环首版（2026-10-03）

运行 `npm.cmd run start:print`，打开 `http://127.0.0.1:4337/reconstruct`。按正、左、背方向分别上传PNG/JPEG（每张≤5MiB、12M像素），手动指定1～180mm最长边。当前使用背景简单或已处理的图片，局部功能保护与打印方案优化仍在另一条平面流程中，不能称任意照片的完整制造方案。

## 实际完成的完整任务

任务`1ac90d72-425f-4a6f-b9f8-50248baa6368`已由真实Agnes 3.0 Flash通过AGH执行 inspect → generate → validate → slice → submit；生成是本机真实Hunyuan3D-2mv推理，不是缓存或模拟结果。用户测试输入为同一张插画设定图拆出的、已清理标注干扰的三张视图，100mm为测试指定值，未证明普通实拍照片的准确重建。

实际采用25步／256分辨率／8000 chunks／seed12345；完整原件与受限导入副本分开保存。提交资产24万面，归一化尺寸约69.061×65.548×100mm，独立导入器检查封闭、面方向、退化、边界、非流形与正体积通过。PrusaSlicer2.9.6使用固定虚拟PLA／0.4mm喷嘴／0.2mm层高，实际生成500层G-code，估算31.95g、14741s。

生成、归一化检查、切片和提交分别绑定实际STL SHA；文件变化后旧切片失效，旧SHA下载请求返回409。任务使用独立空workspace，避免不同任务上下文混入，也使session/start明确记录reconstruction-tools preset。AGH基准工具时限120秒保持不变，只有mesh_generate被已安装插件preset设置为330秒；本地生成进程300秒，任务CLI总600秒。

## 保留的真实边界

- `cb6ecbe6-…`只完成检查即被会话中断，后续加载标记interrupted，未算成功。
- `029c61af-…`在本地模型生成前失败；下载器与生成器的manifest路径契约不一致。已修正路径并补producer/consumer布局回归及实际权重SHA检查，原失败不改写。
- `ba558a25-…`是真实完成的低采样链（5步／128），但造型严重退化。19.39g不能拿来对比31.95g宣称省料，它改变了生成形状。现在首次候选推荐已实测参考配置，页面明确低采样预览与外观未量化验证。

## 尚未验证的结论

拓扑与尺寸通过不是外观还原通过，也不是FDM物理可打印。当前未生成纹理，没有实物打印、强度/热变形测试；关闭支撑的基线仍有桥接/悬垂角色，不能当作省支撑的有效优化。3D曲面ROI、支撑接口与关键区域冲突，以及姿态/参数的受约束搜索将使用独立对照实验验证。

## 源码与配置

- backend：`src/reconstruction-jobs.mjs`、`reconstruction-http.mjs`；原图私有持久化、nonce门禁、图像解码、生成provenance、检查与切片闭环。
- harness：`src/reconstruction-agh.mjs`、`reconstruction-agh-plugin/`；v2隔离home、明确profile/preset、五个固定工具，无任意shell/URL输入。
- 本地模型：`tools/reconstruction/README.md`及其中固定官方版本、许可和准备方法。
- 新任务失败或缺依赖时不返回伪造模型；浏览器不接收Key、token或私有数据库路径。

当前源码需同时具备新插件官方安装/trust/enable、profile显式包引用与preset.allowed配置；单纯看到package-lock enabled不能证明工具加载。实际运行前已用完全阻断网络的编译版CLI探针确认两套工具目录，真正运行另有原生记录。旧detail1.0.1与默认standard-windows保留。
