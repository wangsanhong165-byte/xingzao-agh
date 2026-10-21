# 第三方来源与授权说明

根目录Apache-2.0许可证适用于本项目原创代码。第三方代码、衍生文件、模型和素材保留原作者的权利与许可证，不因存放在本仓库而改用本项目许可证。

## 代码与工具

| 项目 | 来源与固定信息 | 许可与分发范围 |
| --- | --- | --- |
| Agnes Harness | [AgnesAI-Labs/agnes-harness](https://github.com/AgnesAI-Labs/agnes-harness)，固定基础提交`ec7ebbdb36e7658d2a121c3ba5113e850b16cb63` | Apache-2.0。适配补丁、修改文件和原许可证保留于[agh-adaptation](agh-adaptation/README.md)。本仓库不分发开发机账号或私人AGH目录。 |
| JSCAD | [jscad/OpenJSCAD.org](https://github.com/jscad/OpenJSCAD.org)，依赖版本见`package-lock.json` | MIT。通过npm安装，依赖包内保留原许可证。 |
| Three.js | [mrdoob/three.js](https://github.com/mrdoob/three.js)，依赖版本见`package-lock.json` | MIT。通过npm安装，依赖包内保留原许可证。 |
| PrusaSlicer | [prusa3d/PrusaSlicer](https://github.com/prusa3d/PrusaSlicer)，安装清单见[tools/setup/slicer-cli-manifest.json](tools/setup/slicer-cli-manifest.json) | AGPL-3.0。源码、官方发行版及其许可按上游获取；本仓库提供调用、下载和校验脚本，不把切片器作为原创代码重新授权。 |
| Hunyuan3D-2 | [Tencent-Hunyuan/Hunyuan3D-2](https://github.com/Tencent-Hunyuan/Hunyuan3D-2)，源码与模型获取见[运行与模型配置](运行与模型配置.md) | 遵循上游源码及模型各自的许可条款。本仓库不包含完整生成模型或权重，使用前应阅读官方许可证。 |
| Python几何与图像依赖 | 包括NumPy、OpenCV、Trimesh、Rtree、Manifold3D等，版本和安装方案见`tools/setup/` | 各自遵循其原许可证。仓库提供调用与安装脚本，不将这些第三方库重新授权为本项目代码。 |

业务插件目录内已有的`LICENSE`和`NOTICE`继续适用，应随对应代码保留。

## 公开摄影测试素材

头骨摄影数据：**Photogrammetry Test Set: Skull - Turntable - Strong Lights - White Background**，作者 **alansartlog**，许可 **CC BY 4.0**。

- [原数据仓库](https://gitlab.com/photogrammetry-test-sets/skull-turntable-strong-lights-white-background)
- 固定提交：`37f6ee510d9b5ac31d13052980f67cdbb0688d43`
- [CC BY 4.0许可](https://creativecommons.org/licenses/by/4.0/)
- [输入、图号、哈希和预处理记录](case/skull-input-manifest.json)

预处理包括裁切、缩放、背景分离和透明度处理，具体修改记录保留在上述清单中。模型设定尺寸为演示尺寸，不代表原物体的测量尺寸。该数据相关图片及衍生材料应保留作者、来源、许可链接和修改说明。

## 标准件与演示媒体

标准灯柱为本项目参数化生成的受控测试件；生成代码与实际刀轨样例用于说明软件验证方法。

`demo/`及文档截图中出现的角色形象、参考图和合成配音等用于展示项目功能，其相关权利不纳入根目录Apache-2.0代码授权。本仓库不提供这些素材或声线的独立再授权，也不分发相关TTS模型权重。复现自己的图片任务时，请使用本人制作或获得授权的输入素材。

## 执行记录与私人数据

`evidence/agh/`保留参赛审阅使用的官方界面导出记录。它们用于核查实际工具调用过程，不是模型权重或账号配置。开发机私有图片、私人任务数据库、模型Key和账号凭据不随源码公开。
