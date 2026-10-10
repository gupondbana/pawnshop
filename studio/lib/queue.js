// คิวงานฉาก: Extension มาดึงงานทีละฉาก (pull) แล้วรายงานสถานะกลับ
// โควตาหมด → pause ทั้งคิว จนผู้ใช้กด resume หรือถึงเวลา resumeAt
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, listProjects, updateProject, httpError } from './store.js';

const STATE_FILE = path.join(DATA_DIR, 'queue.json');
const LEASE_MS = 15 * 60 * 1000; // ถ้า Extension หายไปเกิน 15 นาที คืนงานเข้าคิว

let state = { paused: false, pauseReason: '', resumeAt: null, active: null, log: [] };

export async function loadQueueState() {
  try { state = { ...state, ...JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) }; } catch { /* ใหม่ */ }
}
async function persist() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}
function log(msg) {
  state.log = [{ at: new Date().toISOString(), msg }, ...state.log].slice(0, 100);
}

export function getState() {
  return state;
}

export async function enqueue(projectId, sceneIds) {
  return updateProject(projectId, (p) => {
    for (const s of p.scenes) {
      if (sceneIds && !sceneIds.includes(s.id)) continue;
      if (s.status === 'done' && !sceneIds) continue; // ฉากที่เสร็จแล้วไม่ต้องทำซ้ำ เว้นแต่สั่งเจาะจง
      if (!s.prompt.trim()) continue;
      s.status = 'queued';
      s.statusMessage = '';
      s.queuedAt = new Date().toISOString();
    }
  });
}

export async function dequeue(projectId, sceneIds) {
  return updateProject(projectId, (p) => {
    for (const s of p.scenes) {
      if ((!sceneIds || sceneIds.includes(s.id)) && ['queued', 'running'].includes(s.status)) {
        s.status = 'draft';
        s.statusMessage = 'ยกเลิกจากคิว';
      }
    }
  });
}

export async function nextJob() {
  if (state.paused) {
    if (state.resumeAt && Date.parse(state.resumeAt) <= Date.now()) {
      await setPaused(false, '');
    } else {
      return { paused: true, reason: state.pauseReason, resumeAt: state.resumeAt };
    }
  }
  const projects = await listProjects();
  // คืนงานที่ lease หมดอายุ
  for (const p of projects) {
    for (const s of p.scenes) {
      if (s.status === 'running' && Date.now() - Date.parse(s.startedAt || 0) > LEASE_MS) {
        await updateProject(p.id, (pp) => {
          const ss = pp.scenes.find((x) => x.id === s.id);
          ss.status = 'queued';
          ss.statusMessage = 'หมดเวลา คืนเข้าคิว';
        });
        s.status = 'queued';
      }
    }
  }
  if (projects.some((p) => p.scenes.some((s) => s.status === 'running'))) {
    return { busy: true }; // ทำทีละฉาก
  }
  const candidates = projects
    .flatMap((p) => p.scenes.filter((s) => s.status === 'queued').map((s) => ({ p, s })))
    .sort((a, b) => (a.s.queuedAt || '').localeCompare(b.s.queuedAt || '') || a.s.order - b.s.order);
  if (!candidates.length) return { idle: true };

  const { p, s } = candidates[0];
  await updateProject(p.id, (pp) => {
    const ss = pp.scenes.find((x) => x.id === s.id);
    ss.status = 'running';
    ss.startedAt = new Date().toISOString();
    ss.attempts = (ss.attempts || 0) + 1;
    ss.statusMessage = 'ส่งให้ Extension แล้ว';
  });
  state.active = { projectId: p.id, sceneId: s.id };
  log(`เริ่ม ${p.title} / ${s.id}`);
  await persist();
  return {
    job: {
      projectId: p.id,
      sceneId: s.id,
      title: `${p.title} — ฉาก ${s.order}`,
      prompt: s.prompt,
      refImageUrl: s.refImage ? `/files/${p.id}/${s.refImage}` : null,
      wantAudio: true,
    },
  };
}

export async function report(projectId, sceneId, { status, message }) {
  const allowed = ['running', 'done', 'failed', 'quota', 'requeue'];
  if (!allowed.includes(status)) throw httpError(400, 'bad status');
  await updateProject(projectId, (p) => {
    const s = p.scenes.find((x) => x.id === sceneId);
    if (!s) throw httpError(404, 'scene not found');
    if (status === 'requeue') {
      s.status = 'queued'; // ผู้ใช้กดหยุดกลางงาน: คืนเข้าคิว
      s.statusMessage = message || 'คืนเข้าคิว';
    } else if (status === 'quota') {
      s.status = 'queued'; // ไม่นับเป็นล้มเหลว รอทำต่อ
      s.statusMessage = 'โควตาหมด รอทำต่อ';
    } else {
      s.status = status;
      s.statusMessage = message || '';
      if (status === 'running') s.startedAt = new Date().toISOString(); // ต่ออายุ lease
    }
  });
  if (status === 'quota') {
    const hours = Number(process.env.QUOTA_RETRY_HOURS || 0);
    await setPaused(true, message || 'โควตา Meta หมด', hours ? new Date(Date.now() + hours * 3600e3).toISOString() : null);
  }
  if (status !== 'running') state.active = null;
  log(`${projectId}/${sceneId}: ${status} ${message || ''}`);
  await persist();
}

export async function setPaused(paused, reason = '', resumeAt = null) {
  state.paused = paused;
  state.pauseReason = paused ? reason : '';
  state.resumeAt = paused ? resumeAt : null;
  log(paused ? `หยุดคิว: ${reason}` : 'ทำคิวต่อ');
  await persist();
}
