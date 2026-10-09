# 受约束盒体省料对照

这是既有参数化盒体的实际工具对照，还没有接入 AGH 核心任务，也不是照片重建或强度测试。

固定外尺寸 60×40×25 mm、底厚 2 mm、两个底孔位置 ±15 mm 及孔径 5 mm；只允许把侧壁从 2 mm 降到 1.6 或 1.2 mm。三份 STL 使用相同虚拟 PLA / 0.4 mm 喷嘴 / 0.2 mm 层高 / 15%填充 / 2圈壁配置实际切片。

| 允许侧壁厚度 | 切片估算耗材 | 切片估算时间 |
|---|---:|---:|
| 2 mm | 15.06 g | 4363 s |
| 1.6 mm | 12.91 g | 4212 s |
| 1.2 mm | 10.75 g | 3658 s |

在这些已测试候选中，1.2 mm 侧壁耗材估算减少约 28.6%，时间估算减少约 16.2%。不代表强度不变，也不是所有可行打印方案中的全局最优。

独立 Python 工具读取实际 STL，核对文件 SHA、封闭性、面方向与外包围盒，并用射线/三角面求交采样检查底板厚度、孔中心与孔边内外的通透性及侧壁厚度。三份模型采样检查均通过；采样不构成全表面尺寸测量或自相交检查。

本轮独立检查发现原盒体构造的腔体过切同时向下伸展，底厚约 1.99917 mm。已将过切改为只向上伸出盒体，重新生成与切片；新采样底厚为 2.00000 mm。旧结果保留于 `data/material-validation`，修正后结果另存在 `data/material-validation-v2`，没有改写旧模型与验证证据。

复现：

```powershell
node tools/validate-box-material.mjs
data/reconstruction/env-torch-readonly/Scripts/python.exe tools/check-box-preservation.py
```

结果文件为 `data/material-validation-v2/comparison.json` 和 `independent-preservation.json`。输入盒体规格已固定在验证脚本中，不依赖私有旧报告即可重跑。未来需将用户允许修改的区域与功能尺寸确认、候选搜索和拒绝条件纳入 AGH 流程，并以真实物品和功能检查验证实用性。
