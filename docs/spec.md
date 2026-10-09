# 想法 2 第一版：照片到可编辑模型，并比较省料方案

日期：2026-10-01。用户已选定想法 2、要求今天实现第一版，并授权 Luna 辅助开发；追加建模阶段考虑省料。

## 今日范围

本地运行的中文应用：上传最多三张 PNG/JPEG 多视图照片，填写一个已知参考尺寸和需求，使用 Agnes + AGH 请求模型提出结构化建模参数；用户确认／修改参数；普通几何工具生成可编辑参数模型，三维查看，导出 STL 与源参数。未配置赛事 Key 时仍可体验明确标注的手动／示例模式，禁止把示例响应伪装为 AI 识图。

支持三类有限结构：plate（带孔板）、bracket（简单 L 形支架）、box（开口盒）。长度单位 mm，模型坐标 X 宽、Y 深、Z 高，XY 居中，底面 Z=0。孔先仅支持沿 Z 贯穿底板／板件，不支持任意侧孔。拒绝非有限数、不合法尺寸、穿出边界或重叠孔。

省料为可选增强：带孔板在保留外边框和孔周区域后添加有限网格镂空；盒体降低侧壁厚度但保留外尺寸与原底厚；支架暂不自动省料，明确返回未支持。输出真实生成几何的体积对照和给定材料密度下的理论质量估算。不能称为切片耗材、打印成功率或强度验证。

Agnes 判断几何结构与参数时提供不确定性／补充建议；缺少实际尺寸时不把照片像素当毫米测量。模型只能使用固定构造工具，禁止执行模型给出的任意程序。第一版不承诺任意实物自动重建、精密测量或承重保证。

## 接口契约

Spec JSON：

```json
{"name":"带孔板","type":"plate","dimensions":{"width":80,"depth":60,"height":6,"wallThickness":3},"holes":[{"x":-25,"y":0,"diameter":6},{"x":25,"y":0,"diameter":6}]}
```

全部尺寸有限正数；width/depth <=500，height <=500；wallThickness >=1，holes 最多 16。plate 的 height 为板厚；bracket 以 wallThickness 为底板与竖板厚；box 的 wallThickness 为默认侧壁与底厚。box 省料时保留原底厚。

生成选项：`{lightweight:boolean,minWall:number,preserveMargin:number}`，默认 minWall=2，preserveMargin=3。

`POST /api/model` 输入 `{spec,options}`，返回 `{spec,mesh:{positions:number[]},baselineMesh:{positions:number[]},metrics:{originalVolumeMm3,volumeMm3,savedPercent,estimatedMassG,baselineMassG,densityGPerCm3},checks:[{name,status,detail}],warnings:[]}`。STL 导出 `POST /api/export/stl` 使用相同输入并返回 binary STL。参数导出直接下载当前 JSON。

`GET /api/status` 返回 `{aghAvailable,modelConfigured,model,limits}`，不返回密钥。

`POST /api/analyze` 输入 `{photos:[{name,mime,dataBase64}],reference:{valueMm,description},description,preferredType}`，通过真实 AGH 任务执行；未配置时返回清晰的 503，不造假结果。返回 `{spec,assumptions,questions,confidence,execution:{mode:'agh',...}}`。使用受限图片读取、几何验证和任务结果工具，保存可核对的执行记录，只有确认照片实际进入模型的路径才称为识图通过。

## 架构与职责

- 根目录 package.json / lock：项目依赖与运行命令。
- src/geometry.mjs：JSCAD 参数构造、省料与几何验证；src/geometry.test.mjs：拒绝非法几何、孔保留、体积减少等独立验证。
- src/server.mjs：本地 Node HTTP API、静态资源、请求限制与导出。
- src/agh-runner.mjs 与 agh-plugin/：接入现有 AGH 构建，独立任务文件，不改其他 AGH 项目代码。配置与敏感信息不进入前端输出或日志。
- public/index.html / app.js / styles.css：照片、参数、Three.js 预览、省料对照、验证及导出。
- tests/：HTTP 失败／边界与浏览器流程。
- README.md：真实支持范围、运行与 Key 配置、第三方来源、未验证事项。

## 验收

无 Key 下：启动应用、上传照片本地预览、加载示例、参数改动更新真实网格、打开省料并得到真实体积差、错误输入显示错误、STL 能解析且尺寸正确、参数导出可再载入；不能出现伪造 AI 调用日志。

有可用 Key 时另验：真实照片进入 Agnes，AGH 真实调用几何检查并反馈，结构化参数可生成模型；模型误判必须允许校正。若 Key 不可用，本次只报告接口／插件接入证据和离线几何功能，不报告识图成功。
