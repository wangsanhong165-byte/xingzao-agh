# 原生 AGH 插画上色接入验收

> 10月9日更新：后续三组用户角色测试确认生产米坐标导致xatlas UV大面积塌缩，已用工作副本归一化修正并完成原生三组复跑，见[新验收](user-character-validation-2026-10-09.md)。下文保留当时的失败及有限结论，不覆盖旧文件，也不把旧收据追认为新质量证明。

本阶段打通已提交重建候选 → 独立纹理任务 → 原生 AGH 四工具 → 真实本地 Paint → 几何复核 → GLB 下载。**链路与文件检查通过，240k 人物案例的颜色质量未通过视觉验收。** 页面将上色标为实验功能，不作为当前参赛主亮点或高保真成果。

## 实际正常任务

父重建任务 `1ac90d72-425f-4a6f-b9f8-50248baa6368`，纹理任务 `4139f6b3-303a-4103-bc36-7a2edcd8afd2`。

| 项目 | 实际记录 |
| --- | --- |
| AGH preset | texture-tools，独立构建运行时 |
| 调度模型 | deepseek/deepseek-v4.1-flash，经现有 CommandCode 路由 |
| 原生工具调用 | inspect → generate → verify → submit，共四次 |
| 实际模型请求 | 五次；恢复、查看和下载后仍为五次 |
| Paint 输入 | 已提交的 240000 面 STL，单张正面插画参考 |
| Paint 输出 | 2048 × 2048 RGB 纹理；六张生成视图，不是六张真实输入照片 |
| 本地纹理 driver 耗时 | 120.25 秒；不等同完整 AGH/用户等待时间 |
| Torch 峰值 allocated 显存 | 4195.6 MiB；不等同整个机器或驱动的总占用 |
| 几何 | 输入、输出有向三角坐标集合的 float32 指纹相同 |
| GLB 下载 | 10795916 字节，浏览器下载 SHA 与服务交付 SHA 一致 |

源 STL SHA：`8f09708db944f80a3fcdfb0b086e00eb0a83038f668a5a5d58f492e6894be3c9`。

交付 GLB SHA：`ad0a93db3f69722bfbb725a3e88cc73296bd1408fffb93c16c617631ff7d0f70`。

独立 verify 重读源、参考、报告及 GLB；检查实际 UV、内嵌可解码图像、档位尺寸、坐标转换及固定模型/源码版本，不仅复读报告中的成功布尔值。STL 的 Z-up/mm 变为 glTF Y-up/metres：`[x,z,-y]/1000`。允许 UV 接缝拆点，禁止简化或移动三角表面。

审计工具 `tools/diagnostics/audit-texture-job.mjs` 从只读原生账本投影工具、请求与服务事件；不导出密钥、原始数据库行、提示词或推理内容。正常任务证据保存在本机 `data/print-validation/texture-native-4139f6b3-303a-4103-bc36-7a2edcd8afd2.json`。这些本地 data 不自动提交至公开仓库。

## 失败与边界

- 故障注入任务 `9c5ad756-ba50-40f4-8d1e-67390283cee3`：仅修改该任务的私有 STL 副本，父候选未修改。真实原生 inspect 返回 `TEXTURE_SOURCE_CHANGED`，一次工具调用、两次模型请求；未进入生成，未交付 GLB。历史顶层错误仍是 `TEXTURE_SUBMISSION_REQUIRED`；现有代码让后续任务优先保留真实失败工具码，没有重写旧记录。
- 真实 POST `referenceKind=photo` 返回 400，未创建新任务；无访问令牌的工具 POST 返回 403 `TEXTURE_TASK_ACCESS_DENIED`。实际照片去光照没有接入，不能把插画试验称为真实照片上色。
- 失败页面的上色与下载按钮不可用；父白模仍能读取。
- HTTP 恢复不启动模型；浏览器刷新、白模/彩色切换、重置视角、失败页返回与真实下载已检查。390px 测试的文档/body宽度为375px，无横向溢出；临时 viewport 已重置。默认物理侧栏截图与测试 viewport 的显示尺度不同，因此不把缩略截图当布局量测依据。

浏览器实际下载和 HTTP 边界记录在本机 `data/print-validation/texture-browser-boundary-20261005.json`。

## 灰斑调查与收敛决定

生成视图本身颜色正常，raw bake 直接绑定原 UV 后已经出现与最终灰斑对应的缺损。此证据支持问题发生在投影/烘焙链，尚不足以锁定唯一根因。

已用**同一已生成视图、UV 和几何**做三种不重新调用模型的实验：atlas2048→4096、烘焙边缘核缩小、全图最近可信像素补洞。均未消除实际渲染中的斑点。最后一种会跨 UV 岛串色，仅作诊断，没有接入生产或替换原交付文件。

当前案例可信烘焙 texel 数为794420；旧100k诊断案例为1424455。两者的网格并不相同，这不是表面积覆盖率，也不能归因为面数本身。原材质没有 COLOR_0，baseColorFactor为白色；用真实贴图接 emission 渲染复核，排除单纯灯光掩盖。未把超分或补色宣称为几何细节重建。

当前决定：保存原始缺陷和实验记录，停止无证据的参数盲调。上色链路作为实验附加能力，后续主线优先验证完整对象的制造收益。头发几何、背面参考忠实度、物理打印质量和颜色质量均不因文件复核通过而自动成立。

## 进程与运行时边界

Windows venv 的 `Scripts/python.exe` 是 redirector。服务读取该隔离环境的 `pyvenv.cfg`，启动实际 Python 二进制，并在子进程设置 `__PYVENV_LAUNCHER__`；不修改父 Conda 或全局环境。实际冒烟确认子进程的 prefix 为纹理环境、ppid 为服务拥有的 Node进程，且 native rasterizer/xatlas 能导入。

原生 Windows Job Object 在所有模型工作前持有进程：worker 必须收到确切的 stdin 所有权握手才能继续。超时、abort 或服务关闭释放 Job；store 将活动工具与任务状态绑定，结束后取消工具，禁止迟到 submit；下载对最终返回的 buffer 再计算 SHA。单元测试覆盖中断与迟到提交；尚未把真实 GPU 中途强制关闭服务作为本阶段实测证据。

原生 AGH 仅对 texture-tools 增加披露与分发白名单，保留其他 preset。补丁和对应测试已存为可复现项目文件，见 `tools/agh-patches/README.md`。安装使用上游 package manager 的 inspect/install/trust/enable/pin，其他运行时未覆盖。

本机私有 AGH home 曾因额外组的显式读取权限不满足上游 credential ACL 检查。已备份原 ACL，仅移除该 home 根目录的这一额外读取授权，保留用户与 SYSTEM；随后上游诊断验证私有性和 credential readable。没有导出、重写或绕过加密密钥存储。

## 验证和剩余工作

2026-10-05 新鲜检查：项目 Node239项通过；Python texture delivery24项通过；原生 AGH的披露/工具分发/纹理边界86项通过。Python使用独立工作区临时目录，未修改用户系统 Temp 权限。

正常上色与源变更失败均交叉核对原生账本。compact资源降级由实际错误触发并受两次生成预算限制，其逻辑有回归测试，本阶段没有伪造 OOM 来声称真实降级已验证。

下一主线：选择完整可用对象，比较普通切片与现有特征保留/局部修复/姿态选择链的量化收益；对照真实默认切片器能力，保持固定尺寸、输入、配置和评价边界。D型轴公差、卡扣寿命、承载能力仍未实现或实测，不把外部研究报告的数字作为项目成果。

协作约定：禁止 Astra，最高继承主模型档位，同时至多一位同档助手；有明确边界的小任务可用已授权 Luna，不使用5.5。
