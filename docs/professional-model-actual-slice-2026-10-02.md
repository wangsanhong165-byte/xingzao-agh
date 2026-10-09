# 专业网格的虚拟切片记录（2026-10-02）

输入为 `data/reconstruction/generated/user-character-guide-cleaned-zup-100mm-240k.stl`，240,000 triangles。其 SHA 与既有几何导入记录一致；归一化尺寸约为 69.061 × 65.548 × 100 mm，几何闭合检查通过。该导入检查范围仅限网格几何。

本次调用本地 **PrusaSlicer 2.9.6**，固定虚拟配置 `fdm-pla-04`（FDM PLA、0.4 mm 喷嘴、0.2 mm 层高、180 mm 立方虚拟空间），实际进程退出码为 0，G-code 已写入 `data/reconstruction/generated/user-character-actual-slice/result.gcode`。配置未启用支撑，G-code 中 support extrusion 为 0。模型放置偏移为 X/Y +90 mm，实际挤出包围盒中心为 (89.9755, 89.976) mm，接近虚拟床中心 (90, 90) mm。

| 指标 | 实际切片结果 |
|---|---:|
| 层数 | 500 |
| 耗材估算 | 10,710.65 mm / 31.95 g PLA |
| 时间估算 | 14,741 s（约 4 h 5 min） |
| G-code 大小 | 14,214,922 bytes |
| Bridge infill | 2,863 条挤出段 / 2,879.127 mm |
| Overhang perimeter | 3,701 条挤出段 / 1,375.550 mm |
| Support extrusion | 0 条 / 0 mm |

其余模型 extrusion sourceRole 为 External perimeter 105,002.029 mm、Internal infill 96,725.569 mm、Perimeter 56,700.224 mm、Solid infill 45,438.819 mm 和 Top solid infill 1,050.137 mm。脚本从真实 G-code 的 `parseGcodeSegments()` 结果统计这些角色长度。

**边界：** 本记录证明该 STL 被 PrusaSlicer 2.9.6 按给定虚拟 profile 切片，并记录了实际生成的 G-code、角色、耗材和时间估算。配置没有支撑；G-code 中存在 bridge 与 overhang 路径。本次未连接或运行实物打印机，因此不能据此宣称悬垂可打印、人物细节能成形、承重合格或打印成功。

复现命令：

```powershell
node data/reconstruction/generated/slice-professional-model.mjs
```

脱敏结构化结果保存在 `data/reconstruction/generated/user-character-actual-slice-report.json`。
