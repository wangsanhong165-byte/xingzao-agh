# 真正 UV 上色：实际结果与模型选型更新

2026 年 10 月 4 日，用户恢复原照片建模＋制造验证/修正路线后的记录。此前暂停检查点的“权重未下载、未运行”是历史状态；本轮已实际完成 Paint Turbo。尚未接入 AGH 产品上色工具。

## 实际运行

RTX 5060 Laptop 8GB、16GB RAM、Windows、Python 3.12.13、Torch 2.11.0+cu130。使用独立 `env-texture-probe`，没有改父 Conda、旧形状环境、驱动、页面文件或全局 PATH。

真实 Hunyuan3D-Paint-v2-0-Turbo 完成条件渲染、学习模型的多视角颜色生成、UV 烘焙、补色与 GLB 导出；没有用 CPU 顶点投影冒充纹理模型。输入是平面插画，明确跳过 Delight 去光照；真实照片的完整 Delight 流程未验证。

| 实验 ID 后缀 | 输入面数 | 合成视图 / 渲染尺寸 / 贴图尺寸 | 驱动用时 | 峰值已分配 GPU |
|---|---:|---|---:|---:|
| `20261004-v1` | 10000 | 4 / 512 / 1024 | 56.797 秒 | 4022.0 MiB |
| `20261004-100k-v1` | 100000 | 4 / 512 / 1024 | 106.687 秒 | 4028.8 MiB |
| `20261004-100k-six` | 100000 | 6 / 1024 / 2048 | 135.797 秒 | 4190.0 MiB |
| 正式 CLI 独立复跑 `texture-paint-cli-rootcheck-20261004` | 100000 | 6 / 1024 / 2048 | 198.969 秒 | 4190.0 MiB |

前三项的完整 ID 为 `texture-paint-flat-model-` 加后缀；报告保存在 `data/texture-experiments/<ID>/texture-probe.json`。四轮均完成，退出码 0；纹理前后和导出重导入的几何签名相同，GLB 都包含 UV 和真实可解码 RGB 图集。时间包含权重核验、加载、纹理与导出，不是纯神经网络推理计时。最后一轮更慢，不能将 136 秒作为稳定耗时承诺。

峰值显存为 Torch 进程已分配值，不含桌面占用。首次系统内存采样误监测 Windows venv 启动器，未覆盖真实解释器子进程；其 4.1 MiB RSS 不代表模型内存，保留原记录并标为无效。全局 available RAM 曾非常低，但不能由此推导单模型峰值；宿主进程峰值仍未准确测得。不以小算子显存或该错误 RSS 宣称内存问题已解决。

输入白模来自既有 561988 面原始网格，SHA `cbe94e605351c390b09157e415f4b41e7f0d64934c4d4132d5784c76bc370b86`，原文件保留。10000/100000 面是另存的诊断简化副本，简化已改变几何。“几何保持”只指各副本纹理前后的 float32 有向三角形坐标多重集相等，不表示简化与原始模型相等。UV 拆点会改变顶点数量和索引。

上色使用一张正面参考图。4/6 指合成相机视图数，不是输入照片数；背面颜色由模型推测，不称三视图颜色精确还原。外层请求 30 步，pinned Turbo 实际运行 10 个去噪时间步。源实现的 custom-timestep 警告保留，未改采样算法来消除警告。pipeline Turbo、UNet 内部开关和 scheduler spacing 的真实值写入报告。

## 实际视觉取舍

root 用 Blender 4.5.1 重导入 GLB，检查正、侧、背、另一侧和斜视五张固定视图。新纹理以无灯光 Emission 显示 Base Color，不修图或改几何；输入 GLB SHA 前后不变。

10000 面的背面 normal 条件中有大三角分面，模型生成图已带对应拼块，问题不只在烘焙。诊断轮 `texture-paint-flat-model-20261004-v2` 保存了条件图、模型合成图、填补前图集和信任 mask。相同参数改用 100000 面后，大三角拼块显著减轻。六视角组合配置使背部和尾部颜色更连贯，但碎发侧面、头饰、围裙和脸部仍有色块与线条伪影。

结论：值得保留为实验彩色预览；未达到高保真人物自动交付标准，不自动发布为合格资产。不能称纹理恢复了真实发束、比例或遮挡几何。RGB 不是完整 PBR、彩色 FDM 方案；STL 不保存这份 UV 材质。

定性对照为 `data/texture-experiments/texture-paint-review-20261004/comparison.png`。旧投影行使用其既有工作室光照，新 Paint 行无灯光；不可据此计算颜色精度提升百分比。`100k-six/textured.glb` 实际 SHA 为 `549ed87da9b4fcbeb395670b159624cc0a2923f1c78a81acadadb827d86975b3`，6855288 字节，2048×2048 图集。正式 CLI 复跑另存 SHA `add68430c23464bcebcf65f618f6627aa6c183b5b7a8ba5a741f320b85a690fe`，不要求浮点纹理生成/编码逐字节相等。

## 可复现入口

本地实验入口 `tools/reconstruction/run_texture_probe.py`、固定权重清单 `texture_model_manifest.json`、实际渲染 `render_texture_review.py`。使用已有隔离环境、pinned 源、原生扩展和模型缓存；不能当作任意干净电脑的开箱安装包。

在项目根目录，用未使用过的 run ID：

```powershell
& '.\data\reconstruction\env-texture-probe\Scripts\python.exe' -X utf8 '.\tools\reconstruction\run_texture_probe.py' `
  --mesh '.\data\texture-preview-input-20261004-100k\preview-y-up.glb' `
  --image '.\data\reconstruction\user-multiview-views-guide-cleaned\front.png' `
  --run-id texture-paint-your-new-run `
  --render-size 1024 --texture-size 2048 --views 6 --offload model --skip-delight
```

离线运行，无 API 和图片上传；用现有 GPU reservation 串行，拒绝覆盖同名输出。保存实际 GLB、图集、合成图、条件图、填补前贴图、信任 mask 和报告。CLI 已完整实际复跑、重导入五视图检查；13 项既有 CPU 守护测试本轮重跑通过，覆盖 UV 拆点、移动/翻面、错误 key/shape、meta 残留、整数 buffer、mmap 和输入/输出边界。

官方 HF revision `9cd649ba6913f7a852e3286bad86bfa9a2d83dcf` 的 Turbo safetensors 是旧 IPA 结构，不能以 strict=False 丢弃 36 项差异。使用当前 7325432923 字节 BIN，SHA `24e7f1aea8a7c94cee627eb06f5265f19eeff4e19568636c5eaef050cc19ba3d`。1535 项 key/shape 严格核验，mmap/weights-only/meta assign 转 FP16；其余权重按 SHA，小配置按 git blob ID 核验。

HF 下载 SSL EOF/低速后改用腾讯作者 [ModelScope 镜像](https://modelscope.cn/models/Tencent-Hunyuan/Hunyuan3D-2)：逐项比对大小/SHA 与固定 HF 清单一致，再验证精确 Range 响应和最终 SHA；未关闭 TLS 或换未核验模型。三个本轮大权重完成，Delight 大权重未补齐。

### 实际导入源码的版本核验

审查发现权重目录的 modules.py 不能代表实际 sys.path 导入目录的版本。新增 `texture_source_manifest.json`：从作者 Git API 获取固定 commit `f8db63096c8282cb27354314d896feba5ba6ff8a` 和 tree `aa9c5e5d318d2ea2825de6c3ca76d6438f661322`，对本地 hy3dgen 下全部 53 个 Python/CUDA/C++/头文件逐项核对大小及 Git blob ID。全部相符，源目录未修改。

CLI 现在在导入任何 hy3dgen 代码前核验固定的预期 commit/tree、文件集合和内容，拒绝替换为另一份自洽但非预期版本的清单、源码漂移、缺失/新增、路径越界和链接；成功后才声明 sourceRevision 与 sourceVerification。installed Torch 和已编译二进制扩展不属于此源码清单，构建证据另存。新增 5 项回归与原 13 项共 18 项通过；将校验替换成旧的“只抄 revision”行为时，5 个负例/子例失败，实际 53 文件核验也通过。上述完整推理复跑先于这项守护；新守护已独立实际核验，不把 CPU 源码测试冒充重新做神经网络推理。

## Gemini 几何报告：有限采纳

| 候选 | 作者/实现者的证据 | 当前取舍 |
|---|---|---|
| TRELLIS 1 多图 | [官方 #7](https://github.com/microsoft/TRELLIS/issues/7) 为实验条件融合；[社区 #361](https://github.com/microsoft/TRELLIS/issues/361) 用 Torch 2.13，6GB preset 不解码 mesh、无 GLB，含 mesh 的 8–12GB preset 报 7.6–8.1GB | 留作第二候选，不能称当前本机稳定可用；社区轮子未证明兼容 Torch 2.11 |
| TripoSG 单图 | [README](https://github.com/VAST-AI-Research/TripoSG) 至少 8GB；[源码](https://github.com/VAST-AI-Research/TripoSG/blob/main/triposg/inference_utils.py) 顶层导入 diso，实际使用 DiffDMC | 先核查原生依赖，再做单图白模对照；未安装或跑模型，“零编译、稳定 5.8GB”未证实 |
| Hunyuan3D-2.1 优化版 | [Windows 维护者](https://github.com/YanWenKun/Hunyuan3D-2-WinPortable) 宣称最大优化 shape 3GB VRAM，同时要求至少 24GB RAM | 原版规格不能推出所有优化版必失败；本机 RAM 不满足该包说明，不优先部署 |
| ReconViaGen / TRELLIS2 | [作者仓库](https://github.com/GAP-LAB-CUHK-SZ/ReconViaGen) 给 v0.2 16图 <18/<24GB，v0.5 已融合 TRELLIS2，欢迎失败反馈 | 本机未确认，不承诺手绘正交图比例严格锁定，没有接入新付费云 API |

“SDF 在数学上必然融合独立发束”错误：两个分离球体的并集就有分离的零等值面。有厚度独立实体与零厚度开放单面不同。模型容量、训练先验、有限输入和采样可能丢细节，不是 SDF 完全不能表达分离实体。

2mv 保留为真实跑通的多视图基准，不称本机最佳。只在同源白模、轮廓、局部特征、运行代价和失败样例显示收益后换模型；更多面数和好看的纹理不能代替几何还原证据。

TripoSG 的原生依赖再核查：当前 [PyPI DISO](https://pypi.org/project/diso/) 0.1.4 发布文件只有 `diso-0.1.4.tar.gz`；[DISO 作者](https://github.com/SarahWeiii/diso) 明确为 CUDA 实现。需先做 isolated 编译小测试，不能称零编译。TripoSG 当前 requirements 还固定旧 `numpy==1.22.3`，不整包盲装到现有 Python 3.12 环境或替换当前依赖。

## 落地假设与下一批验证

优先验证小型文创/桌面摆件与微缩道具的制作准备：设计图/照片生成彩色审阅资产，在指定尺寸/打印条件下展示关键几何是否丢失、支撑接触位置、允许的修改与切片代价，并由 AGH 修正/复核/交付。它与现有能力一致，但仍是待试用的应用假设，没有客户访谈或付费需求证据。

精密维修件、承重结构、医疗和免组装机构暂不作为主承诺；照片尺度、配合公差、载荷与实物制造证据不足。纹理解决识别/审阅，制造检查解决几何，都要分别验证。

查重时承认现有能力：[Prusa Arachne](https://help.prusa3d.com/article/arachne-perimeter-generator_352769) 已有变线宽和最小特征处理；[Meshy repair](https://docs.meshy.ai/en/api/repair-printability) 已有拓扑修复；[Style2Fab](https://hcie.csail.mit.edu/research/style2fab/style2fab.html) 已研究功能/外观区域分离。不能把这些包装为原创，也不因已有研究直接否决有用应用。

下一批应以当前 Arachne 合理默认和人工调整作公平基线，分别量化输入还原、操作耗时、关键特征保留、耗材/支撑代价与停止原因。单直杆受控闭环不能代表普通照片/复杂人物；要迁移到一个真实完整对象并保留失败。AGH 的价值由任务收益和执行证据支撑，不以调用次数自证。
