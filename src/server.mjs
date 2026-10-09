import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, access } from 'node:fs/promises';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = path.join(projectRoot, 'public');
const threeRoot = path.join(projectRoot, 'node_modules', 'three');
const bodyLimit = 83 * 1024 * 1024;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

function problem(message, status = 400, code = 'INVALID_INPUT') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > bodyLimit) throw problem('上传内容过大，最多十二张图片、每张 5 MB。', 413, 'PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('object required');
    return result;
  } catch {
    throw problem('请求内容不是有效的 JSON 对象。', 400, 'INVALID_JSON');
  }
}

export function validatePhotoPayload(payload) {
  if (!Array.isArray(payload.photos) || payload.photos.length < 1 || payload.photos.length > 12) throw problem('请上传 1～12 张 PNG/JPEG 照片。');
  const photos = payload.photos.map((photo, index) => {
    if (!photo || !['image/png', 'image/jpeg'].includes(photo.mime)) throw problem(`第 ${index + 1} 张图片须为 PNG 或 JPEG。`);
    if (typeof photo.dataBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(photo.dataBase64) || photo.dataBase64.length % 4 !== 0) throw problem('图片编码不合法。');
    const data = Buffer.from(photo.dataBase64, 'base64');
    if (data.length > 5 * 1024 * 1024) throw problem('单张图片不能超过 5 MB。', 413, 'PHOTO_TOO_LARGE');
    const validPng = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const validJpeg = data.length > 3 && data[0] === 255 && data[1] === 216 && data[2] === 255;
    if ((photo.mime === 'image/png' && !validPng) || (photo.mime === 'image/jpeg' && !validJpeg)) throw problem('图片内容与格式不一致。');
    return { name: String(photo.name || `视图 ${index + 1}`).slice(0, 120), mime: photo.mime, dataBase64: photo.dataBase64 };
  });
  const reference = payload.reference;
  if (!reference || typeof reference.valueMm !== 'number' || !Number.isFinite(reference.valueMm) || reference.valueMm <= 0 || reference.valueMm > 500) throw problem('请填写 0～500 mm 范围内的已知尺寸。');
  if (typeof reference.description !== 'string' || !reference.description.trim()) throw problem('请说明参考尺寸对应物体的哪条边或哪个部位。');
  if (reference.description.length > 1000 || String(payload.description || '').length > 3000) throw problem('需求描述过长。');
  if (payload.preferredType && !['plate', 'bracket', 'box'].includes(payload.preferredType)) throw problem('不支持该零件类型。');
  return { photos, reference: { valueMm: reference.valueMm, description: reference.description.trim() }, description: String(payload.description || ''), preferredType: payload.preferredType || 'plate' };
}

function inside(root, relative) {
  const absolute = path.resolve(root, relative);
  if (!absolute.toLowerCase().startsWith((path.resolve(root) + path.sep).toLowerCase())) throw problem('路径不可访问。', 404, 'NOT_FOUND');
  return absolute;
}

async function serveStatic(urlPath, response) {
  let file;
  if (urlPath === '/' || urlPath === '/index.html') file = path.join(publicRoot, 'index.html');
  else if (['/app.js', '/styles.css', '/character-test.html', '/character-test.js'].includes(urlPath)) file = path.join(publicRoot, urlPath.slice(1));
  else if (urlPath === '/vendor/three.module.js' || urlPath === '/vendor/three.core.js') file = path.join(threeRoot, 'build', path.basename(urlPath));
  else if (urlPath.startsWith('/vendor/addons/')) file = inside(path.join(threeRoot, 'examples', 'jsm'), urlPath.slice('/vendor/addons/'.length));
  else throw problem('页面不存在。', 404, 'NOT_FOUND');
  let content;
  try { content = await readFile(file); } catch (error) { if (error.code === 'ENOENT' || error.code === 'EISDIR') throw problem('文件不存在。', 404, 'NOT_FOUND'); throw error; }
  response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  response.end(content);
}

const defaultStatus = async () => {
  let status;
  try { status = await (await import('./agh-runner.mjs')).getAghStatus(); }
  catch { status = { aghAvailable: false, modelConfigured: false, model: null, limits: { photos: 12, photoMb: 5 } }; }
  if (status.modelConfigured) return { ...status, analysisMode: 'agh' };
  try {
    const dev = await (await import('./dev-runner.mjs')).getDevStatus();
    if (dev.modelConfigured) return { ...status, ...dev, message: 'DeepSeek 开发验证；赛事运行将使用 Agnes + AGH。' };
  } catch { /* Development adapter is optional. */ }
  return { ...status, analysisMode: 'none' };
};

export function createApp({
  getStatus = defaultStatus,
  analyze = async (payload) => {
    const status = await defaultStatus();
    return status.analysisMode === 'development-deepseek'
      ? (await import('./dev-runner.mjs')).analyzeDevPhotos(payload)
      : (await import('./agh-runner.mjs')).analyzePhotos(payload);
  },
  generate = async (spec, options) => (await import('./geometry.mjs')).generateModel(spec, options),
  exportMesh = async (spec, options) => (await import('./geometry.mjs')).exportStl(spec, options),
  measure = async (payload) => (await import('./measure.mjs')).measurePhoto(payload),
  render = async (spec, options) => (await import('./blender.mjs')).renderModel(spec, options),
  exportScene = async (spec, options) => (await import('./blender.mjs')).exportBlend(spec, options),
} = {}) {
  return http.createServer(async (request, response) => {
    try {
      if (request.method === 'POST' && request.headers.origin) {
        const port = request.socket.localPort;
        if (![ `http://127.0.0.1:${port}`, `http://localhost:${port}` ].includes(request.headers.origin)) throw problem('仅允许本地应用发起任务。', 403, 'ORIGIN_REJECTED');
      }
      const url = new URL(request.url, 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname);
      if (request.method === 'GET' && pathname === '/api/character-test/metadata') {
        const variants = { rough: 'output', fitted: 'fitted-output', hull: 'hull-output' };
        const available = [];
        for (const [name, dir] of Object.entries(variants)) { try { await access(path.join(projectRoot, 'data', 'character-test', dir, 'model.glb')); available.push(name); } catch {} }
        let fitReport, renderScore;
        try { fitReport = JSON.parse(await readFile(path.join(projectRoot, 'data', 'character-test', 'fit-report.json'), 'utf8')); } catch {}
        try { renderScore = JSON.parse(await readFile(path.join(projectRoot, 'data', 'character-test', 'render-score.json'), 'utf8')); } catch {}
        return sendJson(response, 200, { available, fitReport, renderScore });
      }
      if (request.method === 'GET' && pathname.startsWith('/api/character-test/')) {
        let file;
        if (pathname === '/api/character-test/source.png') file = path.join(projectRoot, 'data', 'character-test', 'source.png');
        else {
          const match = pathname.match(/^\/api\/character-test\/(rough|fitted|hull)\/(model\.(?:glb|blend)|(?:front|side|back|perspective)\.png)$/);
          if (!match) throw problem('实验资源不存在。', 404, 'NOT_FOUND');
          file = path.join(projectRoot, 'data', 'character-test', { rough: 'output', fitted: 'fitted-output', hull: 'hull-output' }[match[1]], match[2]);
        }
        let bytes;
        try { bytes = await readFile(file); } catch { throw problem('实验资源尚未生成。', 404, 'NOT_FOUND'); }
        const ext = path.extname(file);
        response.writeHead(200, { 'Content-Type': ext === '.glb' ? 'model/gltf-binary' : ext === '.png' ? 'image/png' : 'application/octet-stream', 'Cache-Control': 'no-cache', ...(ext === '.blend' ? { 'Content-Disposition': 'attachment; filename="character.blend"' } : {}) });
        return response.end(bytes);
      }
      if (request.method === 'GET' && pathname === '/api/status') return sendJson(response, 200, await getStatus());
      if (request.method === 'POST' && ['/api/model', '/api/export/stl', '/api/analyze', '/api/measure', '/api/render', '/api/export/blend'].includes(pathname)) {
        const payload = await readJson(request);
        if (pathname === '/api/measure') return sendJson(response, 200, await measure(payload));
        if (pathname === '/api/analyze') {
          const status = await getStatus();
          if (!status.modelConfigured) throw problem('尚未配置可用的 Agnes 模型。可先体验示例和手动建模，再按 README 接入赛事 Key。', 503, 'MODEL_NOT_CONFIGURED');
          return sendJson(response, 200, await analyze(validatePhotoPayload(payload)));
        }
        if (!payload.spec || typeof payload.spec !== 'object' || Array.isArray(payload.spec)) throw problem('请提供零件模型参数。');
        if (pathname === '/api/model') return sendJson(response, 200, await generate(payload.spec, payload.options || {}));
        if (pathname === '/api/render') return sendJson(response, 200, await render(payload.spec, payload.options || {}));
        if (pathname === '/api/export/blend') {
          const scene = await exportScene(payload.spec, payload.options || {});
          response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="photo-cad.blend"', 'Cache-Control': 'no-store' });
          return response.end(scene);
        }
        const output = await exportMesh(payload.spec, payload.options || {});
        response.writeHead(200, { 'Content-Type': 'model/stl', 'Content-Disposition': 'attachment; filename="photo-cad.stl"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return response.end(Buffer.from(output));
      }
      if (request.method === 'GET') return await serveStatic(pathname, response);
      throw problem('不支持该请求。', 405, 'METHOD_NOT_ALLOWED');
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const status = error.status || (error.code === 'NOT_FOUND' ? 404 : 400);
      sendJson(response, status, { error: error.message || '任务执行失败。', code: error.code || 'INVALID_INPUT' });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PHOTO_CAD_PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PHOTO_CAD_PORT 必须为有效端口。');
  const server = createApp();
  server.listen(port, '127.0.0.1', () => console.log(`照片建模第一版：http://127.0.0.1:${port}`));
  server.on('error', (error) => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请指定 PHOTO_CAD_PORT。` : '本地服务启动失败。'); process.exitCode = 1; });
}
