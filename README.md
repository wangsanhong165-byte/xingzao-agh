# 形造：图片建模与3D打印验证

基于Agnes Harness组织三视图建模、外观区域保护、细杆检查、实际切片与结果复核。规划模型使用DeepSeek V4.1，专业几何生成使用本地Hunyuan3D-2mv。

本仓库提供参赛版本源码、标准灯柱与公开摄影样例、真实G-code，以及AGH运行记录。

- [演示视频](demo/xingzao-demo.mp4)
- [已有结果复核报告](复核报告.html)（下载后用浏览器打开）
- [官方界面导出的AGH运行记录](evidence/agh)
- [完整环境与模型配置](运行与模型配置.md)

## 快速查看与复核

需要Node.js **24.10或更高**，包含npm。Windows PowerShell：

```powershell
git clone https://github.com/wangsanhong165-byte/xingzao-agh.git
cd xingzao-agh
npm.cmd ci
node tools/review/run.mjs
```

该命令重新读取随仓库提供的模型、真实刀轨和文件绑定，生成根目录`复核报告.html`。不调用模型服务，不需要Key或GPU。检查包括细杆覆盖与连续性、既有修改预算，以及公开摄影样例的保护区支撑路径。部分网格探针使用随包缓存，具体范围见报告。

首次从零运行建议：先按上面命令复核样例，再按下面步骤重新生成并切片；需要执行AGH新任务时，按完整配置说明的第1—3步准备CPU工具和账号，图片建模与上色再继续第4—5步。

## 启动工作台

```powershell
$env:PHOTO_CAD_AGH_HOME = Join-Path $env:USERPROFILE '.agh-print-detail-v2'
npm.cmd start
```

浏览器打开 http://127.0.0.1:4337/。工作台可以启动；创建并执行新任务前，需要按[运行与模型配置](运行与模型配置.md)准备Python、PrusaSlicer、AGH和本人模型服务账号。图片建模与上色还需要GPU环境和模型权重。

仓库不包含开发机的私有图片、任务数据库、账号或模型权重。首页案例回看取决于本机是否已有对应任务；第一次克隆时，请先查看上面的复核报告和样例文件，或配置环境后创建自己的任务。

## 重新生成标准件并实际切片

Windows x64、Python **3.12**，在仓库根目录执行：

```powershell
py -3.12 tools/setup/reproduce.py environment --kind cpu-review
py -3.12 tools/setup/reproduce.py assets --scope slicer
& .\data\reconstruction\env-torch-readonly\Scripts\python.exe tools/setup/reslice.py
```

新STL、G-code和结果页写入`data/reproduction-runs/`。GitHub版本由安装器下载固定版本依赖和PrusaSlicer；安装过程需要网络，随后切片在本机完成。它验证标准灯柱的生成与切片，不会重新执行图片生成模型。

## 主要目录

- src、public：工作台服务和界面。
- tools：模型调用、几何处理、切片审计和环境准备。
- pose-agh-plugin、repair-agh-plugin、reconstruction-agh-plugin、texture-agh-plugin：四个业务插件。
- agh-adaptation：固定版本AGH的适配补丁与新增源码。
- tests：接口与流程测试。
- [技术结构与检查范围](docs/architecture.md)：算法、代码入口及结果边界。

图片建模和上色需按运行说明下载权重。当前制造结果通过软件几何及真实刀轨验证，实物打印为后续测试。

## 开源许可与来源

本项目原创代码采用[Apache-2.0](LICENSE)。AGH适配代码及其他第三方内容保留各自的许可证和声明，见[第三方来源与授权说明](THIRD_PARTY_NOTICES.md)。模型权重及演示中的角色图像、配音等素材不纳入本项目代码许可证。

请勿提交`.env`、模型Key、AGH私人账号目录或个人任务数据。需要的配置项见[.env.example](.env.example)，Key使用本人的AGH Provider设置保存。
