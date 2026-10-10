// ทดสอบ flow ทั้งหมดโดยจำลอง Extension: สร้างโปรเจกต์ → บท (ออฟไลน์) → คิว → ส่งวิดีโอเป็น chunk → รวมคลิป
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const PORT = 4399;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clipstudio-'));
const env = { ...process.env, PORT, CLIP_DATA_DIR: data, ANTHROPIC_API_KEY: '' };
const srv = spawn(process.execPath, ['server.js'], { env, stdio: 'inherit', cwd: path.resolve(import.meta.dirname, '..') });
const base = `http://127.0.0.1:${PORT}`;
const j = async (m, p, b, raw) => {
  const r = await fetch(base + p, { method: m, headers: raw ? {} : { 'content-type': 'application/json' }, body: raw ? b : b && JSON.stringify(b) });
  const d = await r.json();
  if (!r.ok) throw new Error(`${m} ${p}: ${d.error}`);
  return d;
};

try {
  for (let i = 0; i < 50; i++) { try { await j('GET', '/api/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  // CORS: เว็บอื่นต้องถูกปฏิเสธ
  const evil = await fetch(base + '/api/projects', { headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);

  let p = await j('POST', '/api/projects', { type: 'knowledge', topic: 'ทำไมท้องฟ้าสีฟ้า' });
  p = await j('POST', `/api/projects/${p.id}/generate`, { sceneCount: 3 });
  assert.equal(p.scenes.length, 3);
  p.scenes[1].subtitle = 'แสงสีฟ้ากระเจิงได้มากกว่าสีอื่น จึงเห็นท้องฟ้าเป็นสีฟ้า';
  p = await j('PUT', `/api/projects/${p.id}`, p);
  await j('POST', `/api/projects/${p.id}/enqueue`, {});

  // จำลอง Extension ทำงานทีละฉาก
  for (let i = 0; i < 3; i++) {
    const next = await j('GET', '/api/queue/next');
    assert.ok(next.job, 'should get job');
    assert.ok((await j('GET', '/api/queue/next')).busy, 'only one job at a time');
    const file = path.join(data, `fake${i}.mp4`);
    // คลิปจำลองขนาดไม่ใช่ 9:16 และฉากที่ 2 ไม่มีเสียง เพื่อทดสอบการ normalize
    const audio = i === 1 ? [] : ['-f', 'lavfi', '-i', `sine=frequency=${300 + i * 200}:duration=3`];
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=${i ? '720x1280' : '640x480'}:rate=24:duration=3`, ...audio, '-shortest', '-pix_fmt', 'yuv420p', file]);
    const buf = fs.readFileSync(file);
    const half = Math.ceil(buf.length / 2);
    await j('POST', `/api/queue/${next.job.projectId}/${next.job.sceneId}/chunk?index=0&total=2`, buf.subarray(0, half), true);
    await j('POST', `/api/queue/${next.job.projectId}/${next.job.sceneId}/chunk?index=1&total=2`, buf.subarray(half), true);
  }
  assert.ok((await j('GET', '/api/queue/next')).idle);

  // โควตาหมด → คิวหยุด
  await j('POST', `/api/projects/${p.id}/enqueue`, { sceneIds: [p.scenes[0].id] });
  const n = await j('GET', '/api/queue/next');
  await j('POST', `/api/queue/${n.job.projectId}/${n.job.sceneId}/status`, { status: 'quota', message: 'test quota' });
  assert.ok((await j('GET', '/api/queue/next')).paused);
  await j('POST', '/api/queue/resume');
  assert.ok((await j('GET', '/api/queue/next')).job, 'resumes same scene');
  await j('POST', `/api/queue/${n.job.projectId}/${n.job.sceneId}/status`, { status: 'done' });

  await j('POST', `/api/projects/${p.id}/render`);
  let r;
  for (let i = 0; i < 240; i++) {
    r = await j('GET', `/api/projects/${p.id}/render`);
    if (r.status !== 'running') break;
    await new Promise((res) => setTimeout(res, 500));
  }
  assert.equal(r.status, 'done', r.message);
  const out = path.join(data, 'projects', p.id, r.result.video);
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', out]));
  const v = info.streams.find((s) => s.codec_type === 'video');
  assert.equal(`${v.width}x${v.height}`, '1080x1920');
  assert.ok(info.streams.some((s) => s.codec_type === 'audio'));
  const dur = Number(info.format.duration);
  assert.ok(dur > 7.5 && dur < 9.5, `duration ${dur}`); // 3 ฉาก x 3 วิ ลบ transition 2 ครั้ง
  // คลิปขายของ: สูตรฉาก + รูปสินค้าจริง + ป้ายราคาทับฉากสุดท้าย
  let pp = await j('POST', '/api/projects', { type: 'product', product: { name: 'ครีมกันแดดหน้าใส', price: '199 บาท', pain: 'หน้ามันทั้งวัน', benefits: 'ซึมไว\nไม่วอก', promo: 'ซื้อ 1 แถม 1' } });
  const img = path.join(data, 'p.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=orange:s=200x200', '-frames:v', '1', img]);
  await j('POST', `/api/projects/${pp.id}/images?name=p.png`, fs.readFileSync(img), true);
  pp = await j('POST', `/api/projects/${pp.id}/generate`, {});
  assert.equal(pp.scenes.length, 6); // hook, เปิดตัว, จุดเด่น 2, ผลลัพธ์, ปิดการขาย
  assert.ok(!pp.scenes[0].refImage && pp.scenes[1].refImage && pp.scenes[1].prompt.startsWith('จากรูปนี้'));
  for (const s of pp.scenes) {
    const f = path.join(data, `p-${s.id}.mp4`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=24:duration=2', '-pix_fmt', 'yuv420p', f]);
    await j('POST', `/api/projects/${pp.id}/scenes/${s.id}/video?name=v.mp4`, fs.readFileSync(f), true);
  }
  await j('POST', `/api/projects/${pp.id}/render`);
  for (let i = 0; i < 240; i++) {
    r = await j('GET', `/api/projects/${pp.id}/render`);
    if (r.status !== 'running') break;
    await new Promise((res) => setTimeout(res, 500));
  }
  assert.equal(r.status, 'done', r.message);
  const ass = fs.readFileSync(path.join(data, 'projects', pp.id, 'output', 'subs.ass'), 'utf8');
  assert.ok(ass.includes(',Price,') && ass.includes('199 บาท') && ass.includes(',Cta,'));

  console.log(`✅ smoke test ผ่าน: ${out} (${dur.toFixed(2)}s)`);
} finally {
  srv.kill();
}
