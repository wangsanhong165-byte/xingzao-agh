import { readFile, writeFile, mkdir } from 'node:fs/promises';

const imagePath = process.argv[2];
if (!imagePath) throw new Error('需要三视图图片路径');
const prompt = `你是三维角色建模助手。请根据用户这张正面、侧面、背面设定图，设计一个真实立体、可从不同方向观看的彩色粗模。它是蓝发女仆鱼尾Q版角色。不要只画一个平面，不要生成代码，不要把三视图当三个独立人物。
输出严格JSON，无Markdown，尽量紧凑输出。schema：{"name":"...","heightMm":100,"parts":[{"name":"...","shape":"ellipsoid|box|cone|torus|curve","position":[x,y,z],"size":[a,b,c],"rotation":[degX,degY,degZ],"color":[r,g,b],"points":[[x,y,z],...],"radius":1}],"assumptions":["..."],"limitations":["..."]}。
坐标 x向角色右手侧（图片正视左右不必等于角色命名），y正为背后，y负为脸/胸，z上。脚底z约0、最高发箍z约100，整个人物在原点附近。生成28到40个分部件，用于可编辑粗模，不追求精确写实。身高100mm只是统一比例，并非原图实测。
shape解释：ellipsoid的size是三轴完整直径；box完整尺寸；cone size=[下端直径,上端直径,高度]，沿z；torus size=[主环半径,管半径,0]（未旋转时水平XY）；curve的points是世界坐标，radius为管半径，size可省略。ellipsoid等位于position中心，curve以points为准。rotation欧拉角单位度，可省略默认0。颜色是0..1。
重点看图片三视图综合的头大身小比例、头发前刘海与后长发、弯曲分束、白色发箍裙边、脸与眼睛、女仆服和围裙、短腿黑鞋、耳侧鳍状饰物、背后的鱼尾及尾鳍。脸朝y负，尾巴在y正，不要把鱼尾做成长在脸前的第三条腿。必须明显有侧面厚度。尽量避免头发遮掉全部脸。
用具体部件建模：头部/脸/眼白/蓝色虹膜/瞳孔/高光都可用略扁椭球；前后发束用几条弯曲curve或拉长椭球、裙子用cone配白裙摆torus，围裙用椭球、尾巴用curve和两个倾斜扁椭球表现尾鳍。不要写衣服图案文字。size/position都是mm，不超过±200。最多40parts，省略不需要的字段，curve最多6点。
诚实列出限制：这只是几何粗模、缺少准确曲面/纹理/骨骼；不可宣称精确还原、强度、可打印。请直接生成完整JSON。`;
const image = await readFile(imagePath);
const request = { model: process.env.PHOTO_CAD_DEV_MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + image.toString('base64') } }] }], max_tokens: 12000, thinking: { type: 'disabled' } };
const response = await fetch(process.env.PHOTO_CAD_DEV_BASE_URL + '/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.COMMAND_CODE_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(180000) });
if (!response.ok) throw new Error(`角色建模请求返回 HTTP ${response.status}`);
const result = await response.json();
const content = result.choices?.[0]?.message?.content || '';
await mkdir('data/character-test', { recursive: true });
await writeFile('data/character-test/last-response.json', JSON.stringify({ model: result.model, content, finishReason: result.choices?.[0]?.finish_reason, usage: result.usage }, null, 2));
const plain = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
let recipe;
try { recipe = JSON.parse(plain); } catch { throw new Error(`模型未返回完整有效JSON，结束状态=${result.choices?.[0]?.finish_reason}，正文长度=${content.length}；已保存响应供诊断。`); }
if (!Array.isArray(recipe.parts) || !recipe.parts.length || recipe.parts.length > 100) throw new Error('角色部件数量不合法');
await mkdir('data/character-test', { recursive: true });
await writeFile('data/character-test/recipe.json', JSON.stringify(recipe, null, 2));
await writeFile('data/character-test/request-record.json', JSON.stringify({ provider: 'commandcode', model: result.model, inputImageName: imagePath.split(/[\\/]/).at(-1), usage: result.usage, finishReason: result.choices?.[0]?.finish_reason, note: '开发验证：真实图像输入与模型生成配方，尚需 Blender 构造与视觉对照；不是 Agnes 实测。' }, null, 2));
console.log(JSON.stringify({ model: result.model, parts: recipe.parts.length, usage: result.usage, limitations: recipe.limitations }, null, 2));
