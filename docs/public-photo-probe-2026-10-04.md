# 真实照片输入试跑与未通过的还原度

## 来源与处理

来源为 [Photogrammetry Test Set: Dice - Turntable - Strong Lights - Opaque Watercolors](https://gitlab.com/photogrammetry-test-sets/dice-turntable-strong-lights-opaque-watercolors)，原作者 alansartlog 按 CC BY 4.0 授权。具体仓库 README 的许可与署名已本机保存并核对，源 commit 为 `cdc5d61096de9b879026b06a6aac11f790377753`。单图引用应标出图号。原照片是经过水彩处理的实物骰子，不是渲染或 AI 图片。

仓库共有 32 张 4272×2848 JPG，约 56 MiB。单图像素数略高于本项目 12MP 上限，因此从紫色主体保守阈值分割获得裁切框，保留边距后下采样到 1024² RGBA。原图未改，没有超分或人工补画。原/衍生 SHA、裁切、mask 及署名存于 `data/public-dice-views/dice-watercolor-turntable-20261004-v1/manifest.json`。

本次采用 01/09/17，并手工假定为正/侧/背。源数据没有相机标定、角度测量或 GT 网格；“32 帧等角度”的推断未经作者数据确认，因此这些输入标签只是实验假设，不能拿角度或三视图一致性作真值。

## 真实执行

任务 `520f4b79-0eba-4211-8bcf-5311f8b04889` 由 AGH 原生 inspect→generate→validate→slice→submit 完成。模型为 CommandCode `deepseek/deepseek-v4.1-flash`，5 次原生调用、6 次持久化模型请求；账本工具顺序与服务事件一致。

专业生成采用现有固定 Hunyuan3D-2mv、25 步、256 提取分辨率、chunks 8000、seed 12345；没有下载新模型。测试选定最长边 30 mm，这不是照片测得的物件尺寸。生成阶段约 99.161 秒，Torch peak allocated 5559.2 MiB。

候选 `c595146761200c004d0db1f14bfa66b58aa66f9535d0d7181e4f0d204c8f5aba`：导入副本 240000 面，约 27.036×30×29.662 mm，几何检查通过。实际切片产生 148 层，虚拟估算 7.66 g、1999 秒；含 bridge/overhang 角色，没有证明真实可打印。

## 结论与用途

实际渲染保留了圆角骰子的整体外形和部分点窝，但生成骰面的点数/布局没有与输入图稳定对应。没有 GT，输入相机关系也未验证，无法分离模型生成误差与视图指定误差。不能据此宣称还原准确率。

**本次结果：流程通过，外观还原未通过。** 保留为真实照片失败/边界样例，不用于主展示的准确建模结论。后续优先选相机方向更可靠、视角明确且形状更简单的实物输入；不能靠上色掩盖几何和视图关系问题。

公开来源代码与许可链接可写入复现文档；照片、衍生图、网格和私有执行数据仍放在 data，不进入本轮源码提交。脱敏原生核查摘要位于 `data/dice-native-evidence.json`。
