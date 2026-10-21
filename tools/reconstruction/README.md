# 重建与几何工具

新机器安装与完整运行统一按根目录[运行与模型配置](../../运行与模型配置.md)执行，不需要开发机的Conda环境或私人路径。

本目录包含Hunyuan形状与纹理调用、模型检查、局部圆杆修改、特征探针和实验工具源码。生产工具的Python解释器由项目配置或安装器准备，不自动使用系统中未知的环境。

## 常用入口

- `tools/setup/reproduce.py`：准备分层Python环境、固定工具源码与资产。
- `tools/setup/reslice.py`：重新生成标准灯柱并实际切片。
- `local_rod_repair_v2.py`：对确认的直圆杆执行局部受预算约束的修改。
- `rod_target_proposal.py`：根据点选位置提出待用户确认的杆件参数。

返回[项目README](../../README.md)。Hunyuan上游来源及授权见[第三方说明](../../THIRD_PARTY_NOTICES.md)。
