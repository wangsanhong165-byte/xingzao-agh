# 轻量复核包

此包用于检查已有工程证据，不代替完整赛事提交。源代码、明确列出的网格、真实G-code、缓存探针、图像、许可署名和脱敏原生摘要一起打包；不包含.env、私有AGH数据库、环境或模型权重。

构建命令：`node tools/review/bundle.mjs --snapshot data/review-evidence-20261007/snapshot.json`。输出为 `data/review-bundles/<UUID>/` 和同名ZIP，不覆盖旧包。构建器采用文件白名单、哈希及非链接路径核对，单文件不超过25MiB，证据、源码和快照总载荷不超过190MiB，并排除模型权重目录/常见权重扩展。实际ZIP大小仍应在提交前检查。

解压进入含 `bundle-manifest.json` 的目录后：

```powershell
node tools/review/check.mjs --bundle .
```

只需Node≥24.10，不需Key、GPU或npm安装。校验器逐文件核对大小/SHA，重新生成刚性位姿字节、核对床面放置，重算缓存探针与真实G-code的特征、连续轴线以及预算选项。只有已验证的不合格才可以与失败样例相符；缺失线宽、损坏探针等未知证据会使复核阻断。

缓存探针没有在此步骤从网格重新生成，几何修改预算没有重算；模型请求和实物没有重跑。清单本身没有数字签名，哈希用于一致性与损坏核对，不是不可篡改证书。

10月7日旧包案例包括原件直立失败、0.7mm断段边界、0.8mm修正正常，以及原0.5mm模型-90°放平的独立強基线。10月8日代码已将侧放纳入新工作流五项，旧任务仍沿用四项；新快照`data/review-evidence-20261008/snapshot.json`额外收录原生五项原件交付、小预算零修改交付和真实失败状态。更新包应使用新UUID，不覆盖旧哈希。见[五姿态验收](five-pose-validation-2026-10-08.md)。

提供的三张照片衍生图与240k切片源的三张alpha渲染可另行重算轮廓代理（需要Python、NumPy、SciPy、Pillow）：

```powershell
python tools/reconstruction/compare_shape_silhouettes.py --reference-dir case/skull/reference --candidate delivered=case/skull/delivered-alpha --candidate-mask render-alpha --output-dir data/new-photo-proxy-check
```

输出目录须不存在。作者、CC BY 4.0、图号、裁切及原/衍生哈希见包内输入清单。该代理未标定相机，不是三维真值、尺寸精度或完整语义还原率。原始611k展示网格与240k制造输入分别记录。

生成器还需要本机Git与Python标准zipfile；可用 `PHOTO_CAD_GIT` 指定Git，默认优先本机已安装的Codex运行时Git，再用PATH。运行已有包的复核器不需要Git。完整现场/在线任务另需AGH配置、专业模型、切片器和相应运行环境。

视频、公开内容、团队身份与本人声明仍需提供。UUID内部包名不是赛事规定的最终命名，正式上传前由队长核对并改为真实组别、参赛编号、队伍名、队长名。
