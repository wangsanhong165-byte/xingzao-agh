# 形造：图片建模与3D打印验证

基于Agnes Harness组织三视图建模、外观区域保护、细杆检查、实际切片与结果复核。规划模型使用DeepSeek V4.1，专业几何生成使用本地Hunyuan3D-2mv。

本仓库提供完整源码与受控测试输入。[复核报告](复核报告.html)和evidence/agh记录可直接查看；完整演示视频随参赛包提供。完整环境、AGH和模型安装步骤见[运行与模型配置](运行与模型配置.md)。

AGH记录通过官方界面的导出按钮生成，各任务目录保留原始诊断ZIP及解压后的对话、轨迹、日志和系统信息。

## 启动工作台

Node.js 24.10以上。参赛包已附Node和JS依赖；GitHub源码用户先安装Node并执行npm.cmd ci。

在本目录的PowerShell执行：

```powershell
$env:PATH = (Join-Path $PWD 'data/tools/node-v24.16.0-win-x64') + ';' + $env:PATH
$env:PHOTO_CAD_AGH_HOME = Join-Path $env:USERPROFILE '.agh-print-detail-v2'
node src/print-server.mjs
```

工作台：http://127.0.0.1:4337/。已有案例可直接查看，执行新任务需完成AGH及工具配置。

## 复核与重新切片

```powershell
node tools/review/run.mjs
```

该命令复核随包模型和真实刀轨，输出中文报告。无需Key或GPU。

Python3.12 x64可重新生成标准灯柱并实际切片：

```powershell
py -3.12 tools/setup/reproduce.py environment --kind cpu-review
py -3.12 tools/setup/reproduce.py assets --scope slicer
& .\data\reconstruction\env-torch-readonly\Scripts\python.exe tools/setup/reslice.py
```

新STL、G-code和结果页写入data/reproduction-runs。参赛包附CPU依赖及PrusaSlicer CLI；GitHub版本由安装器下载。

## 主要目录

- src、public：工作台服务和界面。
- tools：模型调用、几何处理、切片审计和环境准备。
- pose-agh-plugin、repair-agh-plugin、reconstruction-agh-plugin、texture-agh-plugin：四个业务插件。
- agh-adaptation：固定版本AGH的适配补丁与新增源码。
- tests：接口与流程测试。

图片建模和上色需按运行说明下载权重。当前制造结果通过软件几何及真实刀轨验证，实物打印为后续测试。
