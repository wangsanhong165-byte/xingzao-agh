import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateModel } from './geometry.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.PHOTO_CAD_PYTHON || path.join(root, '.venv', 'Scripts', 'python.exe');

export async function measurePhoto(payload) {
  const { photo, widthMm, thicknessMm } = payload;
  if (!photo || !['image/png', 'image/jpeg'].includes(photo.mime) || typeof photo.dataBase64 !== 'string') throw new Error('请提供第一张 PNG/JPEG 照片。');
  if (![widthMm, thicknessMm].every((value) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 500)) throw new Error('请填写实际测量的最长边与板厚，范围为 0～500 mm。');
  const bytes = Buffer.from(photo.dataBase64, 'base64');
  if (!bytes.length || bytes.length > 5 * 1024 * 1024 || bytes.toString('base64') !== photo.dataBase64) throw new Error('图片编码无效或超过 5 MB。');
  try { await access(python); } catch { throw Object.assign(new Error('图像测量 Python 环境未就绪，请按 README 安装。'), { status: 503, code: 'MEASURE_UNAVAILABLE' }); }
  const base = path.join(root, 'data', 'measurements');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'photo-'));
  const input = path.join(dir, photo.mime === 'image/png' ? 'input.png' : 'input.jpg');
  await writeFile(input, bytes);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(python, [path.join(root, 'tools', 'measure_plate.py'), '--image', input, '--width-mm', String(widthMm), '--thickness-mm', String(thicknessMm)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error('图像测量超时，请缩小照片后重试。'), { status: 504, code: 'MEASURE_TIMEOUT' })); }, 15000);
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); if (output.length > 1000000) child.kill(); });
    child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('无法启动图像测量工具。')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let json;
      try { json = JSON.parse(output); } catch { return reject(new Error('图像测量工具没有返回有效结果。')); }
      if (code !== 0 || json.error) return reject(Object.assign(new Error(json.error || '照片不适合当前测量条件。'), { code: json.code || 'MEASURE_REJECTED', status: 400 }));
      resolve(json);
    });
  });
  generateModel(result.spec, {});
  const overlayPath = path.resolve(result.overlayPath || result.overlay_path || path.join(dir, 'overlay.png'));
  if (!overlayPath.toLowerCase().startsWith((dir + path.sep).toLowerCase())) throw new Error('图像工具输出路径无效。');
  let overlay;
  try { overlay = { mime: 'image/png', dataBase64: (await readFile(overlayPath)).toString('base64') }; } catch { /* Annotation is optional; geometry result is separately validated. */ }
  const { overlayPath: ignored, overlay_path: ignoredOther, ...safe } = result;
  return { ...safe, overlay, execution: { mode: 'classical-vision', measuredImage: String(photo.name || '第一张照片'), note: '普通图像算法测量；厚度与最长边来自人工测量，不是 AI 识图。' } };
}
