// เก็บโปรเจกต์เป็นไฟล์ในเครื่อง: data/projects/<id>/{project.json, assets/, scenes/, audio/, output/}
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.CLIP_DATA_DIR || path.resolve('data');
const PROJECTS = path.join(DATA_DIR, 'projects');

export const CLIP_TYPES = ['product', 'story', 'fable', 'knowledge', 'horror', 'follower'];

export function projectDir(id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw httpError(400, 'invalid project id');
  return path.join(PROJECTS, id);
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\-]+/g, '_');
  return base.slice(-80) || 'file';
}

export async function listProjects() {
  await fs.mkdir(PROJECTS, { recursive: true });
  const ids = await fs.readdir(PROJECTS);
  const out = [];
  for (const id of ids) {
    try { out.push(await getProject(id)); } catch { /* ข้ามโฟลเดอร์เสีย */ }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createProject({ title, type, topic, details, links }) {
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = projectDir(id);
  for (const sub of ['assets', 'scenes', 'audio', 'output']) {
    await fs.mkdir(path.join(dir, sub), { recursive: true });
  }
  const project = {
    id,
    title: title || topic || 'โปรเจกต์ใหม่',
    type: CLIP_TYPES.includes(type) ? type : 'story',
    input: { topic: topic || '', details: details || '', links: links || [], images: [] },
    script: null, // { hook, body, ending, caption, hashtags }
    characters: [],
    scenes: [],
    settings: { transition: 'fade', transitionSec: 0.4, burnSubtitles: true, titleOverlay: true },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveProject(project);
  return project;
}

export async function getProject(id) {
  const raw = await fs.readFile(path.join(projectDir(id), 'project.json'), 'utf8').catch(() => {
    throw httpError(404, 'project not found');
  });
  return JSON.parse(raw);
}

// เขียนแบบ atomic เพื่อกันไฟล์เสียเมื่อมีการเขียนพร้อมกัน
export async function saveProject(project) {
  project.updatedAt = new Date().toISOString();
  const file = path.join(projectDir(project.id), 'project.json');
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(project, null, 2));
  await fs.rename(tmp, file);
  return project;
}

let lock = Promise.resolve();
// อัปเดตแบบเรียงคิว กัน race ระหว่าง UI กับ Extension
export function updateProject(id, fn) {
  const run = lock.then(async () => {
    const p = await getProject(id);
    const result = await fn(p);
    await saveProject(p);
    return result === undefined ? p : result;
  });
  lock = run.catch(() => {});
  return run;
}

export async function saveFile(id, sub, filename, buffer) {
  const name = safeName(filename);
  const file = path.join(projectDir(id), sub, name);
  await fs.writeFile(file, buffer);
  return `${sub}/${name}`;
}
