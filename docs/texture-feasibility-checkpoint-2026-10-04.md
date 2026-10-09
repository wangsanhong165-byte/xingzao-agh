# 真正 UV 纹理：源码核查与运行准备

> 本文为此前暂停时的历史检查点。用户恢复推进后的完整 Paint 实测、视觉取舍和复现入口见 `texture-model-first-run-2026-10-04.md`；本文末尾“未下载/未运行/暂停”不代表当前状态。

目标是保留既有几何，生成可导出的完整 RGB 纹理 GLB。此阶段是开发实验，尚未接入 AGH 正式任务或证明视觉还原改善；2.0 RGB 纹理也不等于 2.1 的完整 PBR。

## 已确认的运行前置状态

- 独立 `env-texture-probe` 通过只读依赖路径复用现有 reconstruction 包，不改父 Conda、原环境或全局 PATH。
- xatlas 0.0.11、pybind11 2.13.6、ninja 1.11.1.3 安装于新环境；CPU mesh_processor 的 cp312 wheel 已构建、安装、独立实际调用验证。
- pinned Paint import 成功。构造 CPU-device MeshRender 明确因缺失 custom_rasterizer 停止；没有下载完整贴图权重或伪造纹理结果。
- 独立 CUDA 13.0 redistributable 工具链已在 `D:\黑客松\texture-lab\cuda-13.0-portable` 完成：8 个官方组件按 NVIDIA manifest 大小、SHA-256 校验，许可证与提取索引保留。Windows OEM 解码、Ninja Unicode 路径、SDK/系统工具路径与 MSVC 选项只在构建子进程修正，不改 Torch 包文件或系统设置。pinned rasterizer 源代码没有改动，所有构建错误保留原日志。
- GPU rasterizer 的 cp312 wheel SHA-256 为 `119985474d08dc07c5e0caf5521d1b239fb3c1ccf463f0976b811b0c08416dd5`。root 独立重跑实际小三角和盒体：1250 可见像素，重心坐标有限、求和最大误差 1.19e-7；盒体 normal/position 均 64×64×3 且有限。峰值分配 8.649 MiB，预留 22 MiB。这是小算子测试，不是完整模型显存需求。证据为 `data/texture-render-closeout-root-20261004.json`。

## 对 Gemini 报告的取舍

1. **保留小网格原生算子测试的顺序。** 先验证可见面索引、有限的重心坐标与真实渲染，再加载大模型。
2. **本地源码已修复 LLP64 问题。** pinned `rasterizer_gpu.cu` 的 111 行已经使用 `(int64_t)maxint`，三个 data_ptr 也是 `int64_t`；不重复应用报告中的旧补丁。
3. **UV 不保留原索引数组。** pinned `mesh_uv_wrap` 明确重写 vertices 和 faces，接缝处拆点合理。验收采用 float32 精度下的有向三角形坐标多重集签名；UV 拆点/循环换序可通过，空间移动/翻面不能通过，不声称 V/F 数组原样不变。
4. **公开 Issue 证据比报告弱。** [官方仓库 #362](https://github.com/Tencent-Hunyuan/Hunyuan3D-2/issues/362) 的作者环境是 Win11、RTX 5060 8GB、Python 3.11、Torch 2.8 cu128，报告高面数 xatlas 和重复顶点循环的耗时问题；作者说明只测一个 demo。原文未给报告的 6083→999 秒或 7.4→6.8GB 对照数字，不能引用这些数字证明本机性能。
5. **不照搬全局页面文件配置。** 瞬时可用 RAM、GPU 分配峰值、系统提交量需分开测；2GP/CPU offload 能否在本机满足 8GB/16GB 未实测。32–48GB 页面文件不是已证明的统一门槛，当前未改动系统页面文件、驱动或全局 CUDA_HOME。
6. **2GP 的 Turbo 开关不等于 Paint Turbo。** 对应社区代码主要切换 shape 子文件夹，Paint 标准版写死。实验如使用 Paint Turbo，必须明确其权重与 pipeline 设置，不能靠命令旗标推断。

## 权重兼容性：下载前拦住旧 safetensors

固定官方 HF revision `9cd649ba6913f7a852e3286bad86bfa9a2d83dcf`。先下载 24 个小配置/源码文件，没有启动完整大权重下载。

在 meta 设备上无参数数据分配地构建 pinned UNet2p5DConditionModel，得到 1535 项 state tensor，1831213064 个参数；前后没有 CUDA context。随后读取远端 safetensors 的 215920 字节 header：1571 项 F16 tensor，比当前结构多 36 项旧 IP-Adapter 参数。未使用 strict=False 丢弃这些参数。

作者历史说明原因：[初次上传 27268b8](https://huggingface.co/tencent/Hunyuan3D-2/commit/27268b86840829f8376fffc662b3260d02b833d9) 包含旧 IPA safetensors；[后续更新 efb40d8](https://huggingface.co/tencent/Hunyuan3D-2/commit/efb40d890aeade24c68ec7555eb206de8ba68c77) 改了 `.bin` 与 `modules.py`，去掉 IPA 分支，没有同步更新旧 safetensors。[当前作者 loader](https://huggingface.co/tencent/Hunyuan3D-2/blob/9cd649ba6913f7a852e3286bad86bfa9a2d83dcf/hunyuan3d-paint-v2-0-turbo/unet/modules.py) 仍明确读取 `.bin`、strict=True。

root 用受限 PyTorch weights-only unpickler 与 meta storage，只取 ZIP 的 data.pkl/目录元数据（7 个精确 Range 请求，共 383711 字节），确认当前 `.bin` 的 1535 项 F32 tensor 与 pinned factory 完整 keys/shapes 匹配。没有读取或分配全量参数数据，也不证明参数数值或实际推理质量。第一次普通远程 torch.load 元数据探测因多次微小 Range 请求遭 SSL EOF 失败，保留失败报告，没有将其记为成功。

兼容权重：`hunyuan3d-paint-v2-0-turbo/unet/diffusion_pytorch_model.bin`，7325432923 字节，官方 SHA-256 `24e7f1aea8a7c94cee627eb06f5265f19eeff4e19568636c5eaef050cc19ba3d`。对应独立 manifest 在 `data/texture-model-metadata-20261004/manifest-compatible-bin.json`。不把旧 safetensors 当作这个 checkpoint 的等价半精度版。

## 低内存加载与几何验收

`texture_probe_core.py` 的加载器先用 meta factory，按 CPU mmap / weights-only 读取匹配的本地 checkpoint，严格检查完整 keys/shapes/dtype，再 assign；浮点按需转 FP16，整数 buffer 保留，任何残留 meta 参数或 buffer 都拒绝。小模型的 safetensors 与 torch.save ZIP round-trip、错误键/形状、未持久 buffer、UV 拆点、移动/翻面、输出目录保护共 13 项 CPU 测试通过。尚未以真实 7.325GB 权重测量宿主内存峰值，FP16 数据本身仍占内存，不宣称一定满足 16GB。

**当前状态：收尾后暂停。** 用户要求保留原来方案、只从 image-blaster 借鉴思路，并在已有工作收尾后先交流。CUDA 小网格验证已经完成；完整 Paint 权重未下载，完整 UV 上色和视觉验收未运行。低面数实验输入与私有驱动已准备，尚未执行，不计为产品功能。后续是否继续权重下载、哪项实际场景值得做，待交流后决定。生成和运行日志成功、完整 UV 覆盖或颜色填满都不能单独证明还原度提高。
