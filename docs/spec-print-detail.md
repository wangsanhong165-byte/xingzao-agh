# AGH 打印细节保护：已授权执行规格

2026-10-01。用户已决定此方向，全权授权制定计划、分派与开发。下一版在隔离分支开发，原工作台保持可运行；本版本不追求精细人物重建。

最新模型安排：用户今晚报名，预计明天上午收到赛事 Key；今晚仅用 V4.1 Flash 开发验证，不使用 GPT-5.5。Key 到手后进行 Agnes 接入与同案例复测，暂时的模型表现不推断为赛事模型表现。

## 本次必须完成的纵向案例

输入一张高对比字样／徽标 PNG、目标平面标牌宽深与底厚、受保护区域，以及固定的 FDM 配置。基线模型外观可由图片显示，但 STL 只有底板；增强模型把选定区域变为有最小宽度和凸起高度的真实几何。AGH 真实调用检查、增强、切片、复核和提交工具，记录依据、失败与恢复。不能把自写的 direct API 循环或 mock 日志称为 AGH 运行。

最小案例为平面表面，白底深色图案或透明背景；只支持字符／简单徽标，不对任意彩色图片自动确定该凸起什么。宽度、深度和厚度为用户提供。模型统一 mm，XY 居中，底面 z0，浮雕位于 z=baseThickness 上方。ROI为原始图片像素矩形，用户确认保留区域；禁止只改变纹理。

验证层次：几何闭合与尺寸 → 切片器生成真实路径 → 指定高度与区域存在挤出路径。实物效果、承重和真实打印成功率仍未验证。无可行条件时必须返回失败／需要修改条件，不能把全部加粗合并的图案描述为保真。

## 接口与文件契约

```json
{"image":{"name":"徽标.png","mime":"image/png","dataBase64":"..."},"dimensions":{"width":40,"depth":30,"baseThickness":2},"roi":{"x":0,"y":0,"width":512,"height":384},"profileId":"fdm-pla-04","constraints":{"minFeatureWidth":0.8,"reliefHeight":0.6,"maxReliefHeight":1.2,"minFidelity":0.75}}
```

图像最多5MiB、解码最多12M像素；尺寸 1～180mm，底厚 0.8～10mm；reliefHeight 0.2～maxReliefHeight，maxReliefHeight<=3mm；minFeatureWidth0.4～3mm。透视照片和非平面任意网格不在此版自动增强范围内。

geometry 模块 `src/detail-geometry.mjs` exports `inspectDetail(input)`、`buildDetail(input, options)`，options={enhance:false|true, reliefHeight?,minFeatureWidth?}。返回 `{candidateId, spec, mesh:{positions}, metrics:{volumeMm3,...}, checks:[{name,status,detail}], detail:{targetMask, maskWidth, maskHeight, featureBoundsMm, baseZ, fidelity, minWidthMm, ...}, warnings}`。buildDetail的artifact在root工作区data/detail-jobs中保存；`exportDetailStl(input,options)`返回Buffer。candidateId绑定实际输入／选项，可用hash；检查需拒绝越界ROI、非法参数与丢失拓扑。

普通Python工具 `tools/extract_detail.py` CLI `--image <path> --output <json> --width-mm <n> --depth-mm <n> --min-width-mm <n> --roi <x,y,w,h>`，使用OpenCV轮廓与有限形态学操作，输出 `{contours:[{outer:[[x,y],...],holes:[[[x,y],...]]}],targetMask:{width,height,dataBase64},enhancedMask:{...},fidelity,minWidthMm,warnings}`。物理坐标由整张图案映射至标牌XY居中，图像Y向下需转换为3D Y向上。孔洞须保留；不能将A的内孔悄悄填实后报成功。

切片模块 `src/slicer.mjs` exports `getSlicerStatus()`，`sliceArtifact({stlPath,outputDir,profileId='fdm-pla-04'})` 返回 `{gcodePath,metrics:{filamentMm,filamentG,estimatedTimeSeconds},profile,execution:{mode:'actual-slicer',version},warnings}`；路径局限项目data/或tests目录。`analyzeDetailPaths(gcodeText,{baseZ,featureBoundsMm,nozzleDiameter,targetMask?,widthMm?,depthMm?})`返回 `{featureExtrusionLengthMm,featureLayerCount,highestExtrusionZ,hasRaisedDetail,coverage?,previewSvg,checks}`。正确解析G90/G91、M82/M83、G92、挤出回抽、Z跳跃与无挤出的travel，不能仅凭最高Gcode Z或字符串匹配判断细节存在。

AGH运行与插件 `src/print-agh.mjs`, `print-agh-plugin/`；使用独立AGH_HOME在用户目录下，builtin local-dev。从本地被忽略的.env/现有本机配置用合法SDK写入Command Code账户，模型deepseek/deepseek-v4.1-flash，官方base=https://api.commandcode.ai/provider/v1。不得输出Key、上传到其他域名或改用户默认AGH配置。

AGH工具通过loopback服务4337调用：`detail_inspect`、`detail_build`、`detail_slice`、`detail_verify`、`detail_submit`。根服务 `src/print-server.mjs` 暴露 `GET /api/print/status`, `POST /api/print/start`；工具使用 `POST /api/print/tool/{inspect|build|slice|verify|submit}` 输入 `{jobId, candidateId?,options?}`，任务持有原始input。所有候选由服务产生并绑定，不允许模型提交自行重新拼的未验证Spec。submit仅在同candidate有生成、真实切片与verify通过时成功。AGH模型若无法连接、插件未启用，明确错误，禁止direct API fallback冒充底座。

服务exports `createPrintApp`与`executePrintTool`以便测试。工具每步会保存本地脱敏事件，前端通过`GET /api/print/jobs/<id>`查询结果与真实阶段。仅固定用户确认的输入可以修改；建议放宽条件须返回给用户，不能自动更改硬尺寸。

## 验收

- 基线真实STL为平板，切片后baseZ上方没有对应挤出；增强STL有浮雕且路径复核存在；profile、图像、尺寸一致。
- 一个小尺寸／间距不足案例明确检测到细节合并或保真不足，不提交假成功。
- 模拟一次工具超时／错误验证恢复，再保留至少一个真实几何／切片失败处理记录；注入案例明确标记，不作为真实设备故障。
- 至少一条真实AGH正常链与有效执行记录；关键工具在AGH实际注册并调用。
- 中文界面显示原图、单色几何、切片路径、候选对照、AGH进度；下载模型与配置说明。原软件页面不覆盖。
