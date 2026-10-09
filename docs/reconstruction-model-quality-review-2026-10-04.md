# 建模模型、纹理模型与第一轮同图调优

截至 2026 年 10 月 4 日。现用 Hunyuan3D-2mv 是本机已跑通的形状基准，不代表本机能够运行的最佳模型。当前 CPU 顶点投影上色有大面积灰区和边缘伪影，退出正式功能，不继续用这一方法修饰质量不足的输出。

## 本机与来源核对

RTX 5060 Laptop，nvidia-smi 总显存 8151 MiB；Torch 可用设备报告约 8123 MiB，两者计量口径不同。Python 3.12.13，Torch 2.11.0+cu130，计算架构 sm120。系统内存 15.3 GiB；推理期间纹理预检时可用约 0.75 GiB，不能用这一瞬时值代表空闲时资源。VS2022 Build Tools / MSVC 14.44 已安装；nvcc 和标准 CUDA Toolkit 目录不存在。

| 方案 | 作者公开说明与代码 | 本项目取舍 |
|---|---|---|
| Hunyuan3D-2mv | 多视图 shape-only，2.0 官方约 6GB shape；本机当前固定配置峰值 5559.2 MiB | 保留已验证基准，继续独立比较，不能称最好 |
| TripoSG | README 至少 8GB，HF 卡却写大于 8GB；单图生成，无正式纹理管线 | 值得做独立候选可运行性试验，尚未下载/运行，未证明比 2mv 更好 |
| Hunyuan3D-Paint 2.0 / Turbo | 能给已有网格生成 UV 纹理；源码有 CPU offload；官方 16GB 是 shape+texture 总体说明 | 最有针对性的真正纹理候选，8GB 本机未实测；RGB 纹理不是完整 PBR |
| Hunyuan3D-2GP | 作者以 mmgp 管理模型卸载，提供低显存 profile；标准 Paint，Turbo 开关主要针对 shape | 可作为卸载实现参考。Windows、sm120、新 Torch、16GB RAM 的实际峰值需测 |
| Hunyuan3D-2.1 | 官方 shape 10GB，texture 21GB，合计 29GB；PBR | 不能按原版规格承诺本机运行；低显存开关也不能证明全部 texture 支持卸载 |
| Stable Fast 3D | 官方单图默认约 6GB，UV、材质与 GLB；Windows experimental，HF 权重需申请 | 重新生成带色网格的备选，不能作为保留现有 STL 的上色器，未实测还原度 |
| TRELLIS / TRELLIS.2 | 官方分别至少 16GB / 24GB，Linux 测试，原生 CUDA 扩展 | 原版不属于本机已确认可用选项；第三方卸载实现仍需单独核查 |

直接来源：

- [Hunyuan3D-2 README](https://github.com/Tencent-Hunyuan/Hunyuan3D-2)、[Paint 与 offload 源码](https://github.com/Tencent-Hunyuan/Hunyuan3D-2/blob/main/hy3dgen/texgen/pipelines.py)。
- [TripoSG README](https://github.com/VAST-AI-Research/TripoSG)、[HF 模型卡](https://huggingface.co/VAST-AI/TripoSG)、[FP16 加载脚本](https://github.com/VAST-AI-Research/TripoSG/blob/main/scripts/inference_triposg.py)。
- [2GP 作者 README](https://github.com/deepbeepmeep/Hunyuan3D-2GP)、[CPU 初始化与 mmgp profile](https://github.com/deepbeepmeep/Hunyuan3D-2GP/blob/main/gradio_app.py)。2GP 的内存数字是其作者主张，不能冒充腾讯官方规格或本机实测。
- [Hunyuan3D-2.1](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1)、[Stable Fast 3D](https://github.com/Stability-AI/stable-fast-3d)、[TRELLIS](https://github.com/microsoft/TRELLIS)、[TRELLIS.2](https://github.com/microsoft/TRELLIS.2)。

## 第一轮实际同图对照

三图 SHA 一致，固定模型权重/代码快照、100mm 尺度、256 提取分辨率、8000 chunk；比较原始网格。GPU 顺序运行，两次新增推理均完成；没有模型 API 花费。三组均使用当前 Blender 脚本的相同正、侧、背、斜视相机与材质重新渲染。

| 候选 | 步数 / seed | 生成秒数 | 原始面数 | 平均轮廓 IoU | 平均双向边界误差，归一化像素 |
|---|---|---:|---:|---:|---:|
| 基准 | 25 / 12345 | 102.371 | 561988 | 0.75453 | 9.678 |
| 增加步数 | 50 / 12345 | 137.925 | 522672 | 0.75385 | 9.126 |
| 改随机初值 | 25 / 54321 | 83.997 | 490126 | 0.72451 | 9.767 |

每次峰值已分配 GPU 内存均为 5559.2 MiB。运行速度受系统负载影响，此处是各次实际计时，不能据单次数据概括性能。50 步原始 Trimesh 报告未闭合，供导入的 240k STL 副本检查闭合；Blender 导入时合并/清理得到的状态不能覆盖原始检查结果。

结论：增加到 50 步改善了一部分边界距离和表面噪声，但平均轮廓交并比未提升，头发后脑大块曲面、面部与服饰缺失仍明显。54321 seed 的轮廓一致性更差，脸部几何也不稳定。两项不足以替换生产默认值，不再仅靠堆步数或随机碰运气追求质变。

轮廓指标是未标定设定图的代理：每组三视图共享统一缩放、保留宽高比例，水平居中/底边对齐；固定蓝色 Workbench 取前景会受着色边缘影响。没有自由逐图横向拉伸或旋转。它不评估局部头发/面部、纹理、真实三维尺寸、内部或遮挡区域，0.75 不能读作“75% 还原度”。不依据此指标直接交付或自动改默认值。

评价器先用合成缺失附属特征、宽度畸变、共享尺度、空 mask、无蓝色、超宽模型和拒绝覆盖测试，再由 root 重跑：8 项通过。真实报告独立复跑保存在 `data/quality-probe-20261004-silhouette-v2-rootcheck/`；`contact-sheet.png` 是未美化的原图与固定相机原始几何对照。开发调优 CLI 不冒充 AGH 产品内已集成的自动调优。

## 真正纹理的预检与下一步

在大权重下载前实际导入 pinned Paint：首次缺少 xatlas，CUDA rasterizer 和 mesh_processor 均未安装。新建独立 `data/reconstruction/env-texture-probe/`，仅在该子环境安装 xatlas 0.0.11、pybind11 2.13.6 和 ninja 1.11.1.3；既有 reconstruction 环境与父 Conda 不改。

CPU `mesh_processor` 已使用相同 pinned 源的副本编译。两项现成 Windows SDK 路径缺失（UCRT include、SDK bin 的 rc.exe）仅在构建子进程修正；不改全局 PATH。cp312 wheel SHA-256 为 `4d70dcd7944f2010543751a6176ab701d830bb48fa81d91779e930f66a5975d1`，只安装到新纹理环境。root 独立运行三顶点/4×4 纹理的真实 native 调用，输出有限且 mask sum 255→765；结果在 `data/texture-cpu-smoke-root-20261004.json`。这只是 CPU 扩展验证；pinned 默认 smooth 另有 Python 实现，因此不把该扩展当作所有贴图路径的硬要求。

新环境通过一份仅包含路径的 `.pth` 只读复用现有生成环境的依赖（包括 cv2），不复制框架或修改被复用环境。root 再次实际导入 pinned `Hunyuan3DPaintPipeline` 成功；当时构造 `MeshRender(device='cpu')` 因缺少 `custom_rasterizer` 失败，前后 CUDA context 均未初始化，旧失败证据保留在 `data/texture-preflight-20261004-after-build.json`。随后完成隔离 CUDA 13.0 工具链与 GPU rasterizer 编译，root 小三角/盒体实际复跑通过，见 `data/texture-render-closeout-root-20261004.json`。完整纹理权重未下载，完整上色没有成功运行结果，其实际 GPU/宿主内存峰值未知；按用户最新指示，本轮收尾后暂停。

纹理生成补全颜色不等于修复几何。若要改善真实照片几何，应同时检查拍摄视图对应与源分辨率；人物设定图的低分辨率不能由提高提取面数弥补。候选模型将做固定输入对照，而不引用宣传图来宣布优劣。

## Gemini 补充提示词

请研究给已有 3D 网格生成完整 UV 纹理的本地方案。环境：Windows 11、RTX 5060 Laptop 8GB、16GB 内存、Python 3.12、Torch 2.11 CUDA 13.0，已有 VS2022 Build Tools，尚无 CUDA Toolkit。

重点核查 Hunyuan3D-Paint 2.0/Turbo 与 Hunyuan3D-2GP：是否有此类硬件上的成功实测？CPU 初始化、offload、VAE slicing 能否控制加载和推理峰值？哪些渲染扩展必须编译，是否支持 Blackwell？能否保留输入几何，只增加纹理？

优先引用作者仓库、源码、issue 和 release，列出具体版本、显存、内存及失败情况。区分 RGB 纹理与完整 PBR；缺少实测就明确说明，不用“理论上可以”代替证据。最后给出最小验证顺序。
