// Local Content Studio — ฟังเฉพาะ 127.0.0.1 เท่านั้น ไม่เก็บรหัสผ่าน/Cookie/Token ของ Meta
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listProjects, createProject, getProject, updateProject, saveFile, projectDir, httpError, safeName, DATA_DIR, normalizeProduct,
} from './lib/store.js';
import { generateStoryboard } from './lib/ai.js';
import { loadQueueState, getState, enqueue, dequeue, nextJob, report, setPaused } from './lib/queue.js';
import { renderProject } from './lib/render.js';

const PORT = Number(process.env.PORT || 4317);
const HOST = '127.0.0.1';
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_UPLOAD = 300 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.txt': 'text/plain; charset=utf-8', '.ass': 'text/plain; charset=utf-8',
};

const renders = new Map(); // projectId -> { status, message, result }
const domSnapshots = []; // โครงสร้างหน้า Meta ที่ Extension ส่งมาให้ตรวจ

// อนุญาตเฉพาะหน้า Studio เอง และ Chrome Extension (ไม่ให้เว็บอื่นยิงเข้ามา)
function corsOrigin(req) {
  const o = req.headers.origin;
  if (!o) return null;
  if (o.startsWith('chrome-extension://') || o === `http://${HOST}:${PORT}` || o === `http://localhost:${PORT}`) return o;
  return false;
}

async function readBody(req, limit = MAX_UPLOAD) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError(413, 'file too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
const readJson = async (req) => JSON.parse((await readBody(req, 5e6)).toString() || '{}');

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function serveFile(res, file, req) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return send(res, 404, { error: 'not found' });
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = Number(range[1] || 0), end = range[2] ? Number(range[2]) : stat.size - 1;
    res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'accept-ranges': 'bytes' });
  createReadStream(file).pipe(res);
}

const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern}$`), fn });

route('GET', '/api/health', () => ({ ok: true, app: 'clip-studio', ai: Boolean(process.env.ANTHROPIC_API_KEY) }));
route('GET', '/api/projects', () => listProjects());
route('POST', '/api/projects', async (req) => createProject(await readJson(req)));
route('GET', '/api/projects/([\\w-]+)', (req, [id]) => getProject(id));

// แก้บท/Storyboard จาก UI (อัปเดตเฉพาะฟิลด์ที่แก้ได้ ไม่ให้ทับสถานะคิว)
route('PUT', '/api/projects/([\\w-]+)', async (req, [id]) => {
  const body = await readJson(req);
  return updateProject(id, (p) => {
    for (const k of ['title', 'type', 'script', 'characters', 'settings']) if (k in body) p[k] = body[k];
    if (body.product) p.product = normalizeProduct(body.product);
    if (body.input) Object.assign(p.input, { topic: body.input.topic ?? p.input.topic, details: body.input.details ?? p.input.details, links: body.input.links ?? p.input.links });
    if (Array.isArray(body.scenes)) {
      const old = new Map(p.scenes.map((s) => [s.id, s]));
      p.scenes = body.scenes.map((s, i) => {
        const prev = old.get(s.id) || { id: `s${Date.now().toString(36)}${i}`, status: 'draft', video: null, ttsAudio: null };
        const edit = ['duration', 'visual', 'characterIds', 'dialogue', 'subtitle', 'prompt', 'refImage', 'muteOriginal'];
        const next = { ...prev, order: i + 1 };
        for (const k of edit) if (k in s) next[k] = s[k];
        return next;
      });
    }
  });
});

route('POST', '/api/projects/([\\w-]+)/images', async (req, [id], url) => {
  const rel = await saveFile(id, 'assets', `${Date.now()}-${url.searchParams.get('name')}`, await readBody(req, 20e6));
  return updateProject(id, (p) => { p.input.images.push(rel); });
});

route('POST', '/api/projects/([\\w-]+)/generate', async (req, [id]) => {
  const { sceneCount } = await readJson(req);
  const project = await getProject(id);
  const draft = await generateStoryboard(project, { sceneCount: Math.min(Math.max(Number(sceneCount) || 6, 1), 15) });
  return updateProject(id, (p) => Object.assign(p, draft) && undefined);
});

// อัปโหลดเสียง TTS ภายนอกเพื่อแทนเสียง Meta ในฉากนั้น / อัปโหลดวิดีโอฉากเองแบบ manual
route('POST', '/api/projects/([\\w-]+)/scenes/([\\w-]+)/(tts|video)', async (req, [id, sid, kind], url) => {
  const sub = kind === 'tts' ? 'audio' : 'scenes';
  const rel = await saveFile(id, sub, `${sid}-${Date.now()}-${url.searchParams.get('name') || kind}`, await readBody(req));
  return updateProject(id, (p) => {
    const s = p.scenes.find((x) => x.id === sid);
    if (!s) throw httpError(404, 'scene not found');
    if (kind === 'tts') s.ttsAudio = rel;
    else Object.assign(s, { video: rel, status: 'done', statusMessage: 'อัปโหลดเอง' });
  });
});
route('DELETE', '/api/projects/([\\w-]+)/scenes/([\\w-]+)/tts', (req, [id, sid]) =>
  updateProject(id, (p) => { p.scenes.find((x) => x.id === sid).ttsAudio = null; }));

route('POST', '/api/projects/([\\w-]+)/enqueue', async (req, [id]) => enqueue(id, (await readJson(req)).sceneIds));
route('POST', '/api/projects/([\\w-]+)/dequeue', async (req, [id]) => dequeue(id, (await readJson(req)).sceneIds));

route('POST', '/api/projects/([\\w-]+)/render', async (req, [id]) => {
  if (renders.get(id)?.status === 'running') throw httpError(409, 'กำลังเรนเดอร์อยู่');
  const project = await getProject(id);
  const r = { status: 'running', message: 'เริ่ม' };
  renders.set(id, r);
  renderProject(project, (m) => (r.message = m))
    .then(async (result) => {
      Object.assign(r, { status: 'done', result });
      await updateProject(id, (p) => { p.lastRender = { ...result, at: new Date().toISOString() }; });
    })
    .catch((e) => Object.assign(r, { status: 'failed', message: e.message }));
  return r;
});
route('GET', '/api/projects/([\\w-]+)/render', (req, [id]) => renders.get(id) || { status: 'idle' });

// ---- API สำหรับ Chrome Extension ----
route('GET', '/api/queue', () => getState());
route('GET', '/api/queue/next', () => nextJob());
route('POST', '/api/queue/pause', async (req) => { const b = await readJson(req); await setPaused(true, b.reason || 'ผู้ใช้กดหยุด'); return getState(); });
route('POST', '/api/queue/resume', async () => { await setPaused(false); return getState(); });
route('POST', '/api/queue/([\\w-]+)/([\\w-]+)/status', async (req, [id, sid]) => { await report(id, sid, await readJson(req)); return { ok: true }; });
route('POST', '/api/queue/([\\w-]+)/([\\w-]+)/video', async (req, [id, sid], url) => {
  const buf = await readBody(req);
  if (buf.length < 1000) throw httpError(400, 'video too small');
  const ext = (url.searchParams.get('ext') || 'mp4').replace(/\W/g, '').slice(0, 4) || 'mp4';
  const rel = await saveFile(id, 'scenes', `${sid}-${Date.now()}.${ext}`, buf);
  await updateProject(id, (p) => {
    const s = p.scenes.find((x) => x.id === sid);
    if (!s) throw httpError(404, 'scene not found');
    s.video = rel;
  });
  await report(id, sid, { status: 'done', message: 'ดาวน์โหลดแล้ว' });
  return { ok: true, file: rel };
});

// รับวิดีโอเป็นท่อนๆ (จาก blob: URL บนหน้า Meta) แล้วต่อเป็นไฟล์เดียว
route('POST', '/api/queue/([\\w-]+)/([\\w-]+)/chunk', async (req, [id, sid], url) => {
  const index = Number(url.searchParams.get('index')), total = Number(url.searchParams.get('total'));
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 0 || index >= total || total > 200) throw httpError(400, 'bad chunk');
  const part = path.join(projectDir(id), 'scenes', `${safeName(sid)}.part`);
  const buf = await readBody(req, 8e6);
  if (index === 0) await fs.writeFile(part, buf);
  else await fs.appendFile(part, buf);
  if (index < total - 1) return { ok: true };
  const rel = `scenes/${safeName(sid)}-${Date.now()}.mp4`;
  await fs.rename(part, path.join(projectDir(id), rel));
  await updateProject(id, (p) => {
    const s = p.scenes.find((x) => x.id === sid);
    if (!s) throw httpError(404, 'scene not found');
    s.video = rel;
  });
  await report(id, sid, { status: 'done', message: 'ดาวน์โหลดแล้ว' });
  return { ok: true, file: rel };
});

// โครงสร้างหน้าจริงที่ Extension สแกนมา ใช้ตรวจ selector ก่อนเขียนโค้ด (ไม่มีข้อมูลส่วนตัว/cookie)
route('POST', '/api/debug/dom', async (req) => {
  const snap = await readJson(req);
  domSnapshots.unshift({ at: new Date().toISOString(), ...snap });
  domSnapshots.length = Math.min(domSnapshots.length, 10);
  await fs.mkdir(path.join(DATA_DIR, 'dom'), { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, 'dom', `snapshot-${Date.now()}.json`), JSON.stringify(snap, null, 2));
  return { ok: true };
});
route('GET', '/api/debug/dom', () => domSnapshots);

const server = http.createServer(async (req, res) => {
  const origin = corsOrigin(req);
  if (origin === false) return send(res, 403, { error: 'origin not allowed' });
  if (origin) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE');
    res.setHeader('access-control-allow-headers', 'content-type');
  }
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  const url = new URL(req.url, `http://${HOST}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        const m = r.method === req.method && url.pathname.match(r.re);
        if (m) return send(res, 200, await r.fn(req, m.slice(1), url));
      }
      return send(res, 404, { error: 'no route' });
    }
    if (url.pathname.startsWith('/files/')) {
      const [, , id, ...rest] = url.pathname.split('/');
      const base = projectDir(id);
      const file = path.resolve(base, ...rest.map((x) => safeName(decodeURIComponent(x))));
      if (!file.startsWith(base + path.sep)) throw httpError(400, 'bad path');
      return await serveFile(res, file, req);
    }
    const file = path.resolve(PUBLIC, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(PUBLIC)) return send(res, 400, { error: 'bad path' });
    return await serveFile(res, file, req);
  } catch (e) {
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: e.message });
  }
});

await loadQueueState();
server.listen(PORT, HOST, () => console.log(`Clip Studio: http://${HOST}:${PORT}  (data: ${DATA_DIR})`));
