// AI เขียนบท + แบ่งฉาก + สร้าง Prompt สำหรับ Meta AI
// ใช้ Claude API ถ้ามี ANTHROPIC_API_KEY ไม่งั้นใช้ตัวสร้างแม่แบบออฟไลน์ (ให้ทดสอบ flow ได้ก่อน)
import fs from 'node:fs/promises';
import path from 'node:path';
import { projectDir } from './store.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';

const TYPE_GUIDE = {
  product: 'คลิปขายสินค้า: Hook ปัญหา/ผลลัพธ์ใน 2 วินาที, โชว์สินค้าจริง, จุดเด่น 2-3 ข้อ, ปิดด้วย Call to Action',
  story: 'คลิปเล่าเรื่อง: Hook สถานการณ์ชวนสงสัย, มีจุดหักมุม, ตอนจบชวนคอมเมนต์',
  fable: 'นิทาน: ตัวละครชัดเจน ภาพสดใส จบด้วยข้อคิด',
  knowledge: 'คลิปความรู้: Hook ด้วยคำถาม/ข้อเท็จจริงน่าทึ่ง, อธิบายทีละประเด็น, สรุปท้าย',
  horror: 'เรื่องหลอน: บรรยากาศมืด เงียบ ค่อยๆ กดดัน, จบค้างหรือหักมุม (ไม่โจ่งแจ้งรุนแรง)',
  follower: 'คลิปเพิ่มผู้ติดตาม: Hook แรง, คุณค่าที่คนอยากแชร์, ปิดด้วยชวนกดติดตาม',
};

const SCHEMA = `{
  "title": string,
  "script": { "hook": string, "body": string, "ending": string, "caption": string, "hashtags": string[] },
  "characters": [{ "id": string, "name": string, "look": string (รูปลักษณ์ภาษาอังกฤษ ละเอียด ใช้ซ้ำทุกฉาก), "voice": string }],
  "scenes": [{
    "duration": number (วินาที 4-8),
    "visual": string (อธิบายภาพภาษาไทย),
    "characterIds": string[],
    "dialogue": string (บทพูด/บรรยายภาษาไทย สั้นพอพูดจบในฉาก),
    "subtitle": string (ซับไทย),
    "prompt": string (Prompt ภาษาอังกฤษสำหรับสร้างวิดีโอแนวตั้ง 9:16 ใส่ look ของตัวละครเต็มๆ, กล้อง, แสง, การเคลื่อนไหว และระบุบทพูดไทยในเครื่องหมายคำพูดพร้อมบอกว่าใครพูด),
    "useRefImage": boolean
  }]
}`;

export async function generateStoryboard(project, { sceneCount = 6 } = {}) {
  const linkText = await fetchLinks(project.input.links);
  const images = await loadImages(project);
  const draft = process.env.ANTHROPIC_API_KEY
    ? await callClaude(project, linkText, images, sceneCount)
    : offlineDraft(project, sceneCount);
  return normalize(draft, project);
}

async function callClaude(project, linkText, images, sceneCount) {
  const { topic, details } = project.input;
  const text = [
    `ประเภทคลิป: ${TYPE_GUIDE[project.type]}`,
    `หัวข้อ: ${topic}`,
    details && `รายละเอียด: ${details}`,
    linkText && `ข้อมูลจากลิงก์:\n${linkText}`,
    images.length && `มีรูปอ้างอิง ${images.length} รูป (แนบมา) ใช้เป็นภาพสินค้า/ตัวละครหลัก ตั้ง useRefImage=true ในฉากที่ต้องเห็นสิ่งนี้`,
    `แบ่งเป็น ${sceneCount} ฉาก ความยาวรวม 25-50 วินาที สำหรับ TikTok/Reels แนวตั้ง`,
    `ตอบเป็น JSON อย่างเดียวตาม schema:\n${SCHEMA}`,
  ].filter(Boolean).join('\n\n');

  const content = [
    ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } })),
    { type: 'text', text },
  ];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      system: 'คุณคือนักเขียนบทคลิปสั้นภาษาไทยมืออาชีพ และผู้เชี่ยวชาญเขียน Prompt สร้างวิดีโอ AI ให้ตัวละครหน้าตาคงที่ทุกฉาก',
      messages: [{ role: 'user', content }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const out = body.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
  return JSON.parse(json);
}

function offlineDraft(project, n) {
  const t = project.input.topic || project.title;
  const scenes = Array.from({ length: n }, (_, i) => {
    const part = i === 0 ? 'hook' : i === n - 1 ? 'ending' : `เนื้อหาส่วนที่ ${i}`;
    return {
      duration: 5,
      visual: `ฉาก ${i + 1}: ${part} เกี่ยวกับ ${t}`,
      characterIds: ['c1'],
      dialogue: i === 0 ? `รู้ไหม ${t} มีเรื่องที่คนส่วนใหญ่ไม่รู้` : i === n - 1 ? 'ถ้าชอบ กดติดตามไว้นะ' : `ประเด็นที่ ${i} ของ ${t}`,
      subtitle: '',
      prompt: `Vertical 9:16 cinematic video about "${t}", ${part}. A friendly Thai presenter speaks to camera in Thai.`,
      useRefImage: i === 0 && project.input.images.length > 0,
    };
  });
  return {
    title: t,
    script: { hook: scenes[0].dialogue, body: '', ending: scenes[n - 1].dialogue, caption: t, hashtags: ['#fyp'] },
    characters: [{ id: 'c1', name: 'ผู้ดำเนินเรื่อง', look: 'Thai presenter, 25 years old, casual outfit', voice: 'สดใส' }],
    scenes,
  };
}

function normalize(d, project) {
  const chars = (d.characters || []).map((c, i) => ({ id: c.id || `c${i + 1}`, name: c.name || '', look: c.look || '', voice: c.voice || '' }));
  const scenes = (d.scenes || []).map((s, i) => ({
    id: `s${String(i + 1).padStart(2, '0')}`,
    order: i + 1,
    duration: Number(s.duration) || 5,
    visual: s.visual || '',
    characterIds: s.characterIds || [],
    dialogue: s.dialogue || '',
    subtitle: s.subtitle || s.dialogue || '',
    prompt: s.prompt || '',
    refImage: s.useRefImage && project.input.images[0] ? project.input.images[0] : null,
    muteOriginal: false,
    ttsAudio: null,
    status: 'draft', // draft → queued → running → done | failed
    statusMessage: '',
    video: null,
  }));
  return {
    title: d.title || project.title,
    script: { hook: '', body: '', ending: '', caption: '', hashtags: [], ...d.script },
    characters: chars,
    scenes,
  };
}

async function fetchLinks(links = []) {
  const parts = [];
  for (const url of links.slice(0, 3)) {
    if (!/^https?:\/\//.test(url)) continue;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'Mozilla/5.0 ClipStudio' } });
      const html = await res.text();
      const title = html.match(/<title[^>]*>([^<]*)/i)?.[1] || '';
      const desc = html.match(/<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]+content=["']([^"']*)/i)?.[1] || '';
      const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      parts.push(`[${url}]\n${title}\n${desc}\n${body.slice(0, 3000)}`);
    } catch (e) {
      parts.push(`[${url}] อ่านลิงก์ไม่ได้: ${e.message}`);
    }
  }
  return parts.join('\n\n');
}

async function loadImages(project) {
  const out = [];
  for (const rel of project.input.images.slice(0, 3)) {
    const ext = path.extname(rel).toLowerCase();
    const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }[ext];
    if (!mime) continue;
    const buf = await fs.readFile(path.join(projectDir(project.id), rel));
    if (buf.length < 4.5 * 1024 * 1024) out.push({ mime, data: buf.toString('base64') });
  }
  return out;
}
