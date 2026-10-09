# 打印细节保护工作台

此版本验证一个受限任务：把高对比 PNG 字样／徽标变成指定尺寸的单色浮雕，并用真实切片器复核。尚不支持任意照片重建、人物精细建模或任意曲面纹理转浮雕。

## 运行与输入

在本项目目录运行 `npm.cmd run start:print`，打开 <http://127.0.0.1:4337/>。原机械建模工作台仍使用 `npm.cmd start` 和 4317 端口。

- 输入：PNG、人工确认的物理宽深和底厚、保护区域、最小特征宽度、凸起高度与保真要求。
- 基线：只有底板的 STL。印在外观上的图案不等于单色打印的几何细节。
- 增强：将保护区域的图案做成真实几何，在受限网格与形态学处理下保留孔洞和独立组件。
- 复核：相同的固定虚拟 PLA／0.4 mm 喷嘴／0.2 mm 层高配置运行 PrusaSlicer，读取实际 G-code 中凸起区域至少两层的有效挤出路径。

保真度是输入图案与最终几何俯视掩码的 IoU，不是美术质量或实物可读性分数。网格有阶梯误差；过细、过小、拓扑变化或保真不足时应返回失败。耗材与时间来自切片器估计，未连接打印机，未验证强度。

“最小特征宽度”目前是形态学增强的目标参数；输出中的 minWidthMm 记录该目标，不是对所有边角进行精确测量后保证的实际最窄宽度。路径复核证明区域有有效挤出，尚未逐像素证明图案的所有细节都能读清。

## AGH 与开发模型

2026-10-02 已接入赛事 Agnes 3.0 Flash，并获得独立的真实执行证据；早期 Command Code 的 `deepseek/deepseek-v4.1-flash` 记录仅保留为开发对照，不调用 GPT-5.5。

开发使用独立 `~/.agh-print-detail` home 与 `local-dev` profile，不改默认 AGH 配置。AGH 源码补丁位于 `tools/agh-patches/command-code-v41.patch`，增加固定官方端点的 provider；实际 CLI 构建在被忽略的 `data/agh-runtime`。源码基于 AGH `ec7ebbdb36e7658d2a121c3ba5113e850b16cb63`，没有把直接模型 API 循环作为 AGH 底座。

五个自定义工具的package已通过官方inspect／add／trust／enable流程，并在2026-10-02正式Agnes受控任务中完成11次业务调用和有效提交。独立运行需在用户profile引用该包，并向Host传递PackageManager核验的active immutable snapshots；本地隔离CLI已补齐该接线。历史超时和命令桥审批拒绝均保存，不计作成功。实际运行采用原生插件，命令桥保留诊断代码但不作为默认路径。

每次任务通过CLI的正式模型选择在提示发送前绑定所选route/model，避免旧会话继续使用历史模型。正式任务请求14/14为Agnes3.0Flash，见`docs/agnes-native-evidence-2026-10-02.md`。核心 AGH 流程仍为受控平面验证；STL/GLB 几何导入与归一化预览已另行接入工作台，尚未接入 AGH 或任意照片重建。

服务固定图片与硬尺寸、维护候选 ID。只允许增强参数在输入约束内变化。未切片、未通过同候选复核、异任务 ID 或耗尽工具预算均不能提交。任务令牌只供本地短期调用，API Key 不进入浏览器、工具参数或公开结果。

## 安装依赖与第三方

Node >=24.10，`npm.cmd ci`；Python 环境按主 README 的 `requirements.txt` 配置。切片器为官方 PrusaSlicer 2.9.6 Windows portable，详见 `tools/slicer/README.md`，程序与真实输出不纳入 Git。`tools/slicer/fdm-pla-04.ini` 为本项目固定的虚拟配置，不代表已校准的实际打印机。

- AGH：Apache-2.0；本地 Command Code provider 扩展保留原授权。
- 项目工具插件：Apache-2.0，仅涵盖团队原创插件代码，见插件 LICENSE／NOTICE。
- PrusaSlicer：AGPL-3.0，独立 CLI 软件，未复制或修改其源代码。
- JSCAD、Three.js、OpenCV 与 NumPy：见主 README 与相应包授权。
- 用户图片不纳入源码授权；需有合法使用权限。

## 验证命令

```powershell
node --test src/*.test.mjs tests/*.test.mjs
.venv/Scripts/python.exe -m unittest tools.test_extract_detail
```

单元测试包含模拟依赖以检查提交门禁；真实切片测试和实际 AGH 任务证据需分别说明，不能由模拟测试推导模型或设备已运行。`data/print-jobs/<id>/state.json` 保留任务步骤与失败，网页只返回去除任务令牌的公开状态。重启后未结束任务标记为中断，不能静默恢复为成功。
