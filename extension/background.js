// Background (MV3 service worker): ดึงคิวจาก Studio ทีละฉาก ส่งให้ content script บนแท็บ Meta และส่งผลกลับ Studio
// สถานะเก็บใน chrome.storage.session เพราะ service worker ถูกปิด/เปิดใหม่ได้ตลอด
const STUDIO = 'http://127.0.0.1:4317';
const DEFAULT_CFG = {
  metaUrl: 'https://www.meta.ai/',
  selectors: {},
  quotaTexts: [],
  promptPrefix: '',
  promptSuffix: '',
  uploadWaitMs: 4000,
  jobTimeoutMin: 10,
  delayBetweenJobsSec: 20, // เว้นช่วงระหว่างฉาก ไม่ยิงถี่
};

async function cfg() {
  const { config } = await chrome.storage.local.get('config');
  return { ...DEFAULT_CFG, ...config, selectors: { ...(config?.selectors || {}) } };
}
async function saveCfg(patch) {
  const c = await cfg();
  await chrome.storage.local.set({ config: { ...c, ...patch } });
}
async function getRun() {
  const { run } = await chrome.storage.session.get('run');
  return run || { running: false, job: null, text: 'ยังไม่เริ่ม', tabId: null, nextAt: 0 };
}
async function setRun(patch) {
  const run = { ...(await getRun()), ...patch };
  await chrome.storage.session.set({ run });
  chrome.action.setBadgeText({ text: run.job ? '▶' : run.running ? '…' : '' });
  chrome.action.setBadgeBackgroundColor({ color: run.job ? '#2fbf71' : '#4f8cff' });
  chrome.runtime.sendMessage({ type: 'runUpdate', run }).catch(() => {});
  return run;
}

async function studio(method, path, body, raw) {
  const res = await fetch(STUDIO + path, {
    method,
    headers: raw ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' },
    body: raw ? body : body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Studio ${res.status}`);
  return data;
}

async function metaTab() {
  const run = await getRun();
  if (run.tabId) {
    const t = await chrome.tabs.get(run.tabId).catch(() => null);
    if (t && /^https:\/\/(www\.)?meta\.ai\//.test(t.url || '')) return t;
  }
  const [found] = await chrome.tabs.query({ url: ['https://www.meta.ai/*', 'https://meta.ai/*'] });
  const tab = found || (await chrome.tabs.create({ url: (await cfg()).metaUrl, active: true }));
  await setRun({ tabId: tab.id });
  return tab;
}

async function ensureContent(tabId) {
  for (let i = 0; i < 20; i++) {
    const ok = await chrome.tabs.sendMessage(tabId, { type: 'ping' }).catch(() => null);
    if (ok) return;
    if (i === 3) await chrome.scripting.executeScript({ target: { tabId }, files: ['selectors.js', 'content.js'] }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('ติดต่อหน้า Meta ไม่ได้ (ยังโหลดไม่เสร็จหรือไม่ได้ล็อกอิน?)');
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const run = await getRun();
    if (run.job && Date.now() - run.jobStartedAt > ((await cfg()).jobTimeoutMin + 3) * 60000) {
      await finish(run.job, { ok: false, error: 'ไม่ได้รับผลจากหน้า Meta (แท็บถูกปิด/รีโหลด?)' });
      return;
    }
    if (!run.running || run.job || Date.now() < run.nextAt) return;
    const next = await studio('GET', '/api/queue/next');
    if (next.paused) return void (await setRun({ text: `คิวหยุด: ${next.reason}` }));
    if (next.busy) return void (await setRun({ text: 'Studio มีงานค้างสถานะ running' }));
    if (!next.job) return void (await setRun({ text: 'ไม่มีงานในคิว รออยู่' }));

    const job = next.job;
    await setRun({ job, jobStartedAt: Date.now(), text: `เริ่ม ${job.title}` });
    try {
      const tab = await metaTab();
      await ensureContent(tab.id);
      await studio('POST', `/api/queue/${job.projectId}/${job.sceneId}/status`, { status: 'running', message: 'Extension รับงานแล้ว' });
      await chrome.tabs.sendMessage(tab.id, { type: 'runJob', job, cfg: await cfg() });
    } catch (e) {
      await finish(job, { ok: false, error: e.message });
    }
  } catch (e) {
    await setRun({ text: `⚠ ${e.message} (เปิด Studio อยู่หรือไม่?)` });
  } finally {
    ticking = false;
  }
}

async function finish(job, result) {
  const c = await cfg();
  try {
    if (result.ok && result.url) {
      await setRun({ text: 'ดาวน์โหลดวิดีโอจาก URL' });
      const res = await fetch(result.url);
      if (!res.ok) throw new Error(`ดาวน์โหลดไม่ได้ ${res.status} (กด "อนุญาตดาวน์โหลดวิดีโอ" ใน popup)`);
      await studio('POST', `/api/queue/${job.projectId}/${job.sceneId}/video?ext=mp4`, await res.arrayBuffer(), true);
    } else if (result.ok && result.uploaded) {
      // ส่งเป็น chunk ไปแล้ว Studio ปิดงานเอง
    } else if (result.quota) {
      await studio('POST', `/api/queue/${job.projectId}/${job.sceneId}/status`, { status: 'quota', message: result.error });
      await setRun({ running: false, job: null, text: '⏸ โควตา Meta หมด — หยุดคิวแล้ว กลับมากด Start ภายหลัง' });
      return;
    } else if (result.aborted) {
      await studio('POST', `/api/queue/${job.projectId}/${job.sceneId}/status`, { status: 'requeue', message: 'ผู้ใช้กดหยุด' });
      await setRun({ running: false, job: null, text: '⏹ หยุดแล้ว' });
      return;
    } else {
      throw new Error(result.error || 'ไม่ทราบสาเหตุ');
    }
    await setRun({ job: null, text: `✅ เสร็จ ${job.title}`, nextAt: Date.now() + c.delayBetweenJobsSec * 1000 });
  } catch (e) {
    await studio('POST', `/api/queue/${job.projectId}/${job.sceneId}/status`, { status: 'failed', message: e.message }).catch(() => {});
    await setRun({ job: null, text: `❌ ${job.title}: ${e.message}`, nextAt: Date.now() + c.delayBetweenJobsSec * 1000 });
  }
  setTimeout(tick, c.delayBetweenJobsSec * 1000 + 500);
}

chrome.alarms.create('tick', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === 'tick' && tick());

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    switch (msg.type) {
      case 'start':
        await setRun({ running: true, text: 'เริ่มทำคิว', nextAt: 0 });
        tick();
        return { ok: true };
      case 'stop': {
        const run = await getRun();
        await setRun({ running: false, text: '⏹ กำลังหยุด…' });
        if (run.tabId) await chrome.tabs.sendMessage(run.tabId, { type: 'abort' }).catch(() => {});
        if (!run.job) await setRun({ text: '⏹ หยุดแล้ว' });
        return { ok: true };
      }
      case 'getState':
        return { run: await getRun(), cfg: await cfg() };
      case 'saveCfg':
        await saveCfg(msg.patch);
        return { ok: true };
      case 'progress':
        await setRun({ text: msg.text });
        return { ok: true };
      case 'jobResult':
        await finish(msg.job, msg.result);
        return { ok: true };
      case 'videoChunk': {
        const { job, index, total, base64 } = msg;
        const bin = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
        await studio('POST', `/api/queue/${job.projectId}/${job.sceneId}/chunk?index=${index}&total=${total}`, bin, true);
        return { ok: true };
      }
      case 'fetchStudioFile': {
        const res = await fetch(STUDIO + msg.url);
        if (!res.ok) return { ok: false };
        const buf = new Uint8Array(await res.arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return { ok: true, base64: btoa(s), mime: res.headers.get('content-type') || 'image/jpeg' };
      }
      case 'pick': {
        const tab = await metaTab();
        await ensureContent(tab.id);
        await chrome.tabs.update(tab.id, { active: true });
        return chrome.tabs.sendMessage(tab.id, { type: 'pick', role: msg.role });
      }
      case 'pickedSelector': {
        const c = await cfg();
        await saveCfg({ selectors: { ...c.selectors, [msg.role]: msg.selector } });
        chrome.runtime.sendMessage({ type: 'picked', ...msg }).catch(() => {});
        return { ok: true };
      }
      case 'scanDom': {
        const tab = await metaTab();
        await ensureContent(tab.id);
        const snap = await chrome.tabs.sendMessage(tab.id, { type: 'scanDom' });
        await studio('POST', '/api/debug/dom', snap);
        return { ok: true, count: snap.items.length, fileInputs: snap.fileInputs.length };
      }
      case 'testSelectors': {
        const tab = await metaTab();
        await ensureContent(tab.id);
        return chrome.tabs.sendMessage(tab.id, { type: 'testSelectors', selectors: (await cfg()).selectors });
      }
    }
  })().then(reply, (e) => reply({ ok: false, error: e.message }));
  return true;
});
