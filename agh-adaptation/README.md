# AGH 本地适配源码

上游：AgnesAI-Labs/agnes-harness，基础版本 `ec7ebbdb36e7658d2a121c3ba5113e850b16cb63`，Apache-2.0；许可证随本目录保留。

本项目实际使用的 AGH 在该基础版本上有本地适配：CommandCode provider 注册、模型配置与路由、Windows 本地运行、standalone 插件快照，以及纹理任务工具边界。本目录提供全部已修改文件的补丁和新增源码，供复现时还原这些适配；不包含账号或运行环境。

在“完整源码”根目录的 PowerShell 中执行：

```powershell
git clone https://github.com/AgnesAI-Labs/agnes-harness.git data/agh-source
git -C data/agh-source checkout ec7ebbdb36e7658d2a121c3ba5113e850b16cb63
git -C data/agh-source apply --check ../../agh-adaptation/agh-local-adaptations.patch
git -C data/agh-source apply ../../agh-adaptation/agh-local-adaptations.patch
Copy-Item agh-adaptation/files/* data/agh-source/ -Recurse -Force
```

补丁只应用一次。`apply --check` 失败时先核对上游版本及是否已应用，不强制覆盖未知源码。随后按上游源码中的安装指南构建，保留整个 CLI 运行目录，具体步骤见项目 `运行与模型配置.md`。

`files` 目录保留新增的 CommandCode provider、工具边界测试与插件快照说明；补丁也包含对应上游测试调整。导出的执行记录保持任务当时的模型和版本，不根据本次入口修正改写历史记录。
