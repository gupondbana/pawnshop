// รวมฉากด้วย FFmpeg: ปรับทุกฉากเป็น 1080x1920@30, ต่อด้วย Transition, เผาซับ ASS, ปรับเสียง loudnorm
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { projectDir } from './store.js';

const W = 1080, H = 1920, FPS = 30;
const FONT = process.env.SUB_FONT || 'Noto Sans Thai';

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exit ${code}: ${err.slice(-1500)}`))));
  });
}

async function probe(file) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file]);
  const j = JSON.parse(out);
  return { duration: Number(j.format.duration), hasAudio: j.streams.some((s) => s.codec_type === 'audio') };
}

export async function renderProject(project, onProgress = () => {}) {
  const dir = projectDir(project.id);
  const tmp = path.join(dir, 'output', 'tmp');
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true });

  const scenes = project.scenes.filter((s) => s.video).sort((a, b) => a.order - b.order);
  if (!scenes.length) throw Object.assign(new Error('ยังไม่มีวิดีโอฉากไหนเลย'), { status: 400 });

  // 1) Normalize ทีละฉาก
  const parts = [];
  for (const [i, s] of scenes.entries()) {
    onProgress(`ปรับฉาก ${s.order} (${i + 1}/${scenes.length})`);
    const src = path.join(dir, s.video);
    const info = await probe(src);
    const out = path.join(tmp, `n${String(i).padStart(2, '0')}.mp4`);
    const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS},format=yuv420p`;
    const args = ['-y', '-i', src];
    const tts = s.ttsAudio ? path.join(dir, s.ttsAudio) : null;
    if (tts) {
      args.push('-i', tts); // ใช้ TTS ภายนอกแทนเสียงเดิม (ระบบสำรอง)
    } else if (s.muteOriginal || !info.hasAudio) {
      args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    }
    const audioIn = tts || s.muteOriginal || !info.hasAudio ? '1:a' : '0:a';
    args.push(
      '-filter_complex', `[0:v]${vf}[v];[${audioIn}]aresample=48000,aformat=channel_layouts=stereo,apad[a]`,
      '-map', '[v]', '-map', '[a]', '-t', info.duration.toFixed(3),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', out,
    );
    await run('ffmpeg', args);
    parts.push({ file: out, duration: info.duration, scene: s });
  }

  // 2) ต่อฉาก
  onProgress('ต่อฉาก');
  const { transition = 'fade', transitionSec = 0.4 } = project.settings || {};
  const T = transition === 'none' || parts.length < 2 ? 0 : Math.min(transitionSec, ...parts.map((p) => p.duration / 2));
  const joined = path.join(tmp, 'joined.mp4');
  const inputs = parts.flatMap((p) => ['-i', p.file]);
  let filter;
  if (T === 0) {
    filter = parts.map((_, i) => `[${i}:v][${i}:a]`).join('') + `concat=n=${parts.length}:v=1:a=1[v][a]`;
  } else {
    const f = [];
    let v = '[0:v]', a = '[0:a]', acc = parts[0].duration;
    for (let i = 1; i < parts.length; i++) {
      const offset = (acc - T).toFixed(3);
      f.push(`${v}[${i}:v]xfade=transition=${transition}:duration=${T}:offset=${offset}[v${i}]`);
      f.push(`${a}[${i}:a]acrossfade=d=${T}[a${i}]`);
      v = `[v${i}]`; a = `[a${i}]`;
      acc += parts[i].duration - T;
    }
    filter = f.join(';') + `;${v}null[v];${a}anull[a]`;
  }
  await run('ffmpeg', ['-y', ...inputs, '-filter_complex', filter, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', joined]);

  // 3) ซับ + ข้อความ + ปรับเสียง
  onProgress('ใส่ซับและปรับเสียง');
  const ass = buildAss(project, parts, T);
  await fs.writeFile(path.join(tmp, 'subs.ass'), ass);
  const finalName = `final-${Date.now()}.mp4`;
  const final = path.join(dir, 'output', finalName);
  const burn = project.settings?.burnSubtitles !== false;
  await run('ffmpeg', ['-y', '-i', 'joined.mp4',
    ...(burn ? ['-vf', 'ass=subs.ass'] : []),
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', final], { cwd: tmp });
  await fs.copyFile(path.join(tmp, 'subs.ass'), path.join(dir, 'output', 'subs.ass'));

  const caption = [project.script?.caption || project.title, '', (project.script?.hashtags || []).join(' ')].join('\n').trim();
  await fs.writeFile(path.join(dir, 'output', 'caption.txt'), caption + '\n');
  await fs.rm(tmp, { recursive: true, force: true });
  onProgress('เสร็จ');
  return { video: `output/${finalName}`, caption: 'output/caption.txt' };
}

function assTime(t) {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60, c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}
function assText(t) {
  return String(t || '').replace(/[{}]/g, '').replace(/\r?\n/g, '\\N');
}

// แยกซับยาวเป็นท่อนสั้นๆ กระจายตามเวลาของฉาก
function chunks(text, max = 28) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const out = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max && cur) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur);
  return out;
}

function buildAss(project, parts, T) {
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,${FONT},64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,5,2,2,70,70,330,1
Style: Title,${FONT},80,&H0000E5FF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,6,3,8,60,60,220,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = [];
  let t = 0;
  parts.forEach((p, i) => {
    const visible = p.duration - (i < parts.length - 1 ? T : 0);
    const segs = chunks(p.scene.subtitle);
    segs.forEach((seg, k) => {
      const a = t + (visible * k) / segs.length, b = t + (visible * (k + 1)) / segs.length;
      lines.push(`Dialogue: 0,${assTime(a)},${assTime(b)},Sub,,0,0,0,,${assText(seg)}`);
    });
    t += p.duration - T;
  });
  const hook = project.script?.hook;
  if (project.settings?.titleOverlay !== false && hook) {
    lines.push(`Dialogue: 1,${assTime(0)},${assTime(Math.min(2.5, parts[0].duration))},Title,,0,0,0,,{\\fad(150,250)}${assText(hook)}`);
  }
  return head + lines.join('\n') + '\n';
}
