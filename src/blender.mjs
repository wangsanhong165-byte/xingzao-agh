import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { generateModel } from './geometry.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const binary = process.env.PHOTO_CAD_BLENDER || 'C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe';
const tasks = new Map();
let rendering = false;

export async function blenderAvailable() {
  try { await access(binary); return true; } catch { return false; }
}

function runBlender(input, destination) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--background', '--python-exit-code', '1', '--python', path.join(root, 'tools', 'render_views.py'), '--', input, destination], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const collect = (chunk) => { tail = (tail + chunk.toString('utf8')).slice(-5000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error('Blender 渲染超时，请先使用较小的简单模型。'), { status: 504, code: 'RENDER_TIMEOUT' })); }, 90000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`Blender 未完成渲染。${tail.match(/(?:Error|Exception|ValueError|RuntimeError)[^\r\n]{0,200}/)?.[0] || '请查看运行环境。'}`), { status: 500, code: 'RENDER_FAILED' }));
    });
  });
}

export async function renderModel(spec, options = {}) {
  const geometry = generateModel(spec, options);
  if (!await blenderAvailable()) throw Object.assign(new Error('没有找到 Blender，可设置 PHOTO_CAD_BLENDER 指向 blender.exe。'), { status: 503, code: 'BLENDER_NOT_FOUND' });
  const id = createHash('sha256').update(JSON.stringify({ spec, options, version: 1 })).digest('hex').slice(0, 24);
  if (tasks.has(id)) return tasks.get(id);
  if (rendering) throw Object.assign(new Error('Blender 正在处理另一个模型，请稍后重试。'), { status: 409, code: 'RENDER_BUSY' });
  const promise = (async () => {
    const destination = path.join(root, 'data', 'renders', id);
    await mkdir(destination, { recursive: true });
    const input = path.join(destination, 'input.json');
    await writeFile(input, JSON.stringify({ ...geometry, options }));
    rendering = true;
    try { await runBlender(input, destination); } finally { rendering = false; }
    const views = await Promise.all(['top', 'front', 'side'].map(async (name) => ({ name, mime: 'image/png', dataBase64: (await readFile(path.join(destination, name + '.png'))).toString('base64') })));
    const checks = JSON.parse(await readFile(path.join(destination, 'checks.json'), 'utf8'));
    return { id, views, checks, execution: { mode: 'blender', viewProjection: 'orthographic', units: 'mm' } };
  })();
  tasks.set(id, promise);
  try { return await promise; } catch (error) { tasks.delete(id); throw error; }
}

export async function exportBlend(spec, options) {
  const { id } = await renderModel(spec, options);
  return readFile(path.join(root, 'data', 'renders', id, 'model.blend'));
}
