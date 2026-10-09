# image-blaster：重合、差距与主展示取舍

只读核查用户提供的仓库，没有安装/运行其脚本、提交模型 API 请求或使用用户账户。核查 GitHub main commit `4acb43ba126a12358f71838d1b1a05e856b10eaf`；仓库 API 显示创建于 2026-04-21、最近 push 为 2026-05-15，不能把“最近看到”当作刚发布的新模型。

## 它实际完成的工作

image-blaster 是 Claude skills 编排的图像到场景工作流：先识别/确认独立物件、准备单物件参考与背景 clean plate，再分别生成世界、物件资产、音效，在 React/Three.js/Rapier 中查看、移动和交互。物件通过 FAL 的 `fal-ai/hunyuan3d-v3/image-to-3d` 生成，默认 PBR、50k 面；世界通过 World Labs Marble 1.1 生成 SPZ、碰撞 GLB、全景与缩略图。仓库开放工作流和查看器代码，没有提供这些服务的自训练或本地模型权重，生成依赖相应平台密钥。

它确实有请求状态归档、活动请求恢复轮询、下载资产与场景保存；物件抓取/刚体/碰撞/音效也有实现。不要用“只是 API 套壳”抹掉系统整合与体验价值。展示广度、对象/场景分层、交互与视觉包装明显比当前形造的实验状态成熟；3D 质量仍需同图、同约束实测，不能由星数或演示图直接判定。

直接依据：[README](https://github.com/neilsonnn/image-blaster/blob/4acb43ba126a12358f71838d1b1a05e856b10eaf/README.md)、[Hunyuan v3 provider](https://github.com/neilsonnn/image-blaster/blob/4acb43ba126a12358f71838d1b1a05e856b10eaf/.claude/scripts/asset-pipeline/hunyuan-3d.mjs)、[World Labs 与请求续接](https://github.com/neilsonnn/image-blaster/blob/4acb43ba126a12358f71838d1b1a05e856b10eaf/.claude/scripts/world/generate-world.mjs)、[项目状态](https://github.com/neilsonnn/image-blaster/blob/4acb43ba126a12358f71838d1b1a05e856b10eaf/.claude/scripts/project/project-state.mjs)。

## 不宜混淆的能力

核查的目录/生成脚本/查看器中没有发现 PrusaSlicer、G-code、喷嘴/层高工艺配置、关键功能特征的刀轨验收、材料预算下局部修正与重切片证明。它的文件完成状态主要按模型资产存在识别，不能当作制造验收。输出网格可以进一步用于制造，不能据此说它“不能打印”。

查看器确有物理互动；`SceneObject.tsx` 的碰撞体使用对象显示包围盒生成 CuboidCollider，`OBJECT_SCALE=0.5`，默认位置为网格排布，后续可手调和保存。没有证据证明这些位姿/尺寸是源照片的计量恢复或已校准真实力学模型。点击/抓取/音效作为体验功能已不具备单独的稀缺性。

直接依据：[SceneObject](https://github.com/neilsonnn/image-blaster/blob/4acb43ba126a12358f71838d1b1a05e856b10eaf/app/src/modules/scene/SceneObject.tsx)、[默认位置](https://github.com/neilsonnn/image-blaster/blob/4acb43ba126a12358f71838d1b1a05e856b10eaf/app/src/modules/scene/placements.ts)、[编辑器](https://github.com/neilsonnn/image-blaster/blob/4acb43ba126a12358f71838d1b1a05e856b10eaf/app/src/modules/scene/PlacementEditor.tsx)、[抓取](https://github.com/neilsonnn/image-blaster/blob/4acb43ba126a12358f71838d1b1a05e856b10eaf/app/src/modules/scene/useObjectGrab.ts)。

## 对形造的具体影响

1. **基础生成成为可替换输入能力。** 继续改善照片建模与真 UV 纹理，把模型/供应商选择当作质量问题；不把“接上模型生成 GLB”或“多几个工具”当作主要创新。现在本地 Hunyuan3D-2mv 不能称最好，旧投影上色退出正式功能。Cloud v3 与本地 2mv 的资源/模型条件不同，不能直接用于判定 AGH 或语言模型的优劣。
2. **主展示收敛到一个制造任务。** 目标仍是照片到可制造模型，但展示核心应为固定尺寸与保护要求下，发现切片丢失关键特征，选择/局部修正，再由独立几何与真实 G-code 复核，报告保护收益及成本。泛化照片到高质量可交互世界的说法不成立，也不作为当前主线。
3. **借鉴体验组织。** 原图、对象/参考确认、源模型、候选、局部刀轨与最终交付在一个用户流程中对应清楚；参考其资产归档与直观查看方式。当前不用移植完整世界编辑器或音效来增加范围。

已有真实差异：AGH 四姿态成本/保护选择、关键特征审计、0.5→0.8mm 的预算内单直杆修正和重检、孔道约束、局部实际 G-code 与失败停止。但目前修正对象仅限受控直圆杆，实际照片还原、较一般对象和真实打印证据不足，不能据这些样例宣称已经具备获奖优势。

以上取舍作为讨论建议，不代表已经重写项目目标。用户后续明确：只借鉴思路，不直接抄代码，保留原来整套照片建模＋制造验证方案；本轮收尾后暂停交流。当前没有复制 image-blaster 源码或接入 FAL。竞品说明基础方案拥挤，接下来需要讨论应用价值、真实场景与演示收益，不能由对方演示直接判定本项目获奖可能性。
