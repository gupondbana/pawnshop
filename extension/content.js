// ทำงานบนหน้า Meta AI ที่ผู้ใช้ล็อกอินอยู่: รับงานจาก background, ใส่ Prompt, แนบรูป, กดสร้าง, รอวิดีโอ, ส่งไฟล์กลับ
// ไม่อ่าน document.cookie / localStorage / token ใดๆ ของ Meta
(() => {
  if (globalThis.__clipRunnerLoaded) return;
  globalThis.__clipRunnerLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let abort = false;

  // ---------- Overlay แสดงสถานะบนหน้า ----------
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;z-index:2147483647;right:12px;bottom:12px;max-width:340px;padding:8px 12px;border-radius:8px;background:rgba(15,17,21,.92);color:#fff;font:13px system-ui;box-shadow:0 4px 16px #0006;display:none;pointer-events:auto';
  const overlayText = document.createElement('span');
  const stopBtn = document.createElement('button');
  stopBtn.textContent = '⏹ หยุด';
  stopBtn.style.cssText = 'margin-left:8px;background:#ef5350;color:#fff;border:0;border-radius:4px;padding:2px 8px;cursor:pointer';
  stopBtn.onclick = () => chrome.runtime.sendMessage({ type: 'stop' });
  overlay.append('🎬 ', overlayText, stopBtn);
  document.documentElement.append(overlay);

  function status(text) {
    overlay.style.display = 'block';
    overlayText.textContent = text;
    chrome.runtime.sendMessage({ type: 'progress', text }).catch(() => {});
  }

  // ---------- Helpers ----------
  function q(sel) { return sel ? document.querySelector(sel) : null; }
  function qa(sel) { return sel ? [...document.querySelectorAll(sel)] : []; }
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }
  async function waitFor(fn, timeoutMs, label) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (abort) throw new Error('ผู้ใช้กดหยุด');
      const v = await fn();
      if (v) return v;
      await sleep(500);
    }
    throw new Error(`หมดเวลารอ: ${label}`);
  }
  function videoSrc(v) {
    return v.currentSrc || v.src || v.querySelector('source')?.src || '';
  }
  function countQuotaHits(texts) {
    if (!texts.length) return 0;
    const body = document.body.innerText.toLowerCase();
    return texts.reduce((n, t) => n + (t ? body.split(t.toLowerCase()).length - 1 : 0), 0);
  }

  // ใส่ข้อความแบบเดียวกับผู้ใช้พิมพ์ เพื่อให้ React/Lexical รับรู้
  function setPrompt(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      document.execCommand('selectAll', false);
      document.execCommand('delete', false);
      document.execCommand('insertText', false, text);
    }
  }
  function promptText(el) {
    return (el.value ?? el.innerText ?? '').trim();
  }

  async function attachImage(cfg, url) {
    const res = await chrome.runtime.sendMessage({ type: 'fetchStudioFile', url });
    if (!res?.ok) throw new Error('โหลดรูปอ้างอิงจาก Studio ไม่ได้');
    const bin = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0));
    const file = new File([bin], url.split('/').pop(), { type: res.mime });
    const dt = new DataTransfer();
    dt.items.add(file);

    const inputs = qa(cfg.selectors.uploadInput);
    const composer = q(cfg.selectors.promptInput);
    let target = inputs[0];
    for (let a = composer?.parentElement; a && inputs.length > 1; a = a.parentElement) {
      const hit = inputs.find((i) => a.contains(i));
      if (hit) { target = hit; break; }
    }
    if (target?.matches('input[type=file]')) {
      target.files = dt.files;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // ไม่มี input[type=file] → ลองวางไฟล์แบบ drag&drop ลงช่อง Prompt (ต้องทดสอบกับหน้าจริงว่ารองรับ)
      const drop = q(cfg.selectors.promptInput);
      for (const type of ['dragenter', 'dragover', 'drop']) {
        drop.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
    }
    await sleep(cfg.uploadWaitMs || 4000); // รอให้หน้าอัปโหลดรูปเสร็จ
  }

  // ---------- งานหลัก ----------
  async function runJob(job, cfg) {
    abort = false;
    const S = cfg.selectors;
    for (const [role, meta] of Object.entries(globalThis.CLIP_SELECTOR_ROLES)) {
      if (meta.required && !S[role]) throw new Error(`ยังไม่ได้ตั้ง Selector: ${meta.label} — เปิด popup แล้วใช้โหมดเลือก Selector`);
    }
    if (job.refImageUrl && !S.uploadInput) throw new Error('ฉากนี้มีรูปอ้างอิง แต่ยังไม่ได้ตั้ง Selector แนบรูป');

    status(`เริ่ม ${job.title}`);
    if (S.modeButton && cfg.videoModeText && q(S.modeButton) && !q(S.modeButton).innerText.includes(cfg.videoModeText)) {
      status('เลือกโหมดวิดีโอ');
      q(S.modeButton).click();
      const item = await waitFor(() => [...document.querySelectorAll('[role=menuitem],[role=menuitemradio],[role=option],[role=radio],button')]
        .find((el) => visible(el) && el !== q(S.modeButton) && el.innerText.trim().includes(cfg.videoModeText)), 5000, 'เมนูโหมดวิดีโอ');
      item.click();
      await sleep(800);
    }
    if (S.newChat && q(S.newChat)) {
      q(S.newChat).click();
      await sleep(1500);
    }
    const input = await waitFor(() => visible(q(S.promptInput)) && q(S.promptInput), 20000, 'ช่อง Prompt');

    const beforeSrcs = new Set(qa(S.videoResult).map(videoSrc));
    const beforeCount = qa(S.videoResult).length;
    const quotaBefore = countQuotaHits(cfg.quotaTexts);

    if (job.refImageUrl) {
      status('แนบรูปอ้างอิง');
      await attachImage(cfg, job.refImageUrl);
    }

    status('ใส่ Prompt');
    const fullPrompt = [cfg.promptPrefix, job.prompt, cfg.promptSuffix].filter(Boolean).join('\n');
    setPrompt(input, fullPrompt);
    await sleep(600);
    if (!promptText(input)) throw new Error('ใส่ Prompt ไม่ติด — ตรวจ Selector ช่อง Prompt');

    const submit = await waitFor(() => {
      const b = q(S.submitButton);
      return b && visible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true' && b;
    }, 30000, 'ปุ่มส่งพร้อมกด');
    status('กดสร้างวิดีโอ');
    submit.click();

    // รอวิดีโอใหม่
    const started = Date.now();
    let lastSrc = '', stableTicks = 0;
    const src = await waitFor(() => {
      const secs = Math.round((Date.now() - started) / 1000);
      status(`รอ Meta สร้างวิดีโอ… ${secs}s`);
      if (countQuotaHits(cfg.quotaTexts) > quotaBefore) {
        throw Object.assign(new Error('พบข้อความโควตา/ข้อจำกัดบนหน้า'), { quota: true });
      }
      const vids = qa(S.videoResult);
      const fresh = vids.filter((v) => videoSrc(v) && !beforeSrcs.has(videoSrc(v)));
      const cand = fresh[fresh.length - 1] || (vids.length > beforeCount ? vids[vids.length - 1] : null);
      const busy = S.busyIndicator && visible(q(S.busyIndicator));
      if (!cand || busy || !videoSrc(cand)) { stableTicks = 0; return null; }
      const s = videoSrc(cand);
      stableTicks = s === lastSrc ? stableTicks + 1 : 0;
      lastSrc = s;
      return stableTicks >= 4 ? s : null; // src นิ่ง ~2 วิ
    }, (cfg.jobTimeoutMin || 10) * 60000, 'วิดีโอเสร็จ');

    status('ดาวน์โหลดวิดีโอ');
    if (src.startsWith('blob:') || src.startsWith('data:')) {
      const buf = await (await fetch(src)).arrayBuffer();
      await sendChunks(job, buf);
      return { ok: true, uploaded: true };
    }
    return { ok: true, url: src }; // ให้ background ดาวน์โหลดเอง (ต้องได้สิทธิ์ host)
  }

  async function sendChunks(job, buf) {
    const CH = 4 * 1024 * 1024;
    const bytes = new Uint8Array(buf);
    const total = Math.ceil(bytes.length / CH);
    for (let i = 0; i < total; i++) {
      let s = '';
      const part = bytes.subarray(i * CH, (i + 1) * CH);
      for (let j = 0; j < part.length; j += 0x8000) s += String.fromCharCode(...part.subarray(j, j + 0x8000));
      const r = await chrome.runtime.sendMessage({ type: 'videoChunk', job, index: i, total, base64: btoa(s) });
      if (!r?.ok) throw new Error(r?.error || 'ส่งไฟล์ไป Studio ไม่สำเร็จ');
    }
  }

  // ---------- สแกนโครงสร้างหน้าจริง (เพื่อตรวจ ไม่ใช่เดา) ----------
  function scanDom() {
    const sel = 'button,[role=button],[role=menuitem],[role=menuitemradio],[role=option],[role=radio],[role=tab],textarea,input,[contenteditable="true"],[role=textbox],video,[aria-label],[data-testid]';
    const items = [...document.querySelectorAll(sel)].filter(visible).slice(0, 400).map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      placeholder: el.getAttribute('placeholder') || el.getAttribute('aria-placeholder'),
      testid: el.getAttribute('data-testid'),
      contenteditable: el.getAttribute('contenteditable'),
      disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
      text: (el.innerText || '').trim().slice(0, 40),
      selector: buildSelector(el),
    }));
    const fileInputs = [...document.querySelectorAll('input[type=file]')].map((el) => ({ accept: el.accept, multiple: el.multiple, selector: buildSelector(el) }));
    return { url: location.href, title: document.title, viewport: [innerWidth, innerHeight], items, fileInputs };
  }

  // ---------- โหมดเลือก Selector ----------
  function cssEsc(s) { return CSS.escape(s); }
  function unique(s) { try { return document.querySelectorAll(s).length === 1; } catch { return false; } }
  function buildSelector(el) {
    const tag = el.tagName.toLowerCase();
    const attrs = ['data-testid', 'aria-label', 'placeholder', 'aria-placeholder', 'name', 'role'];
    for (const a of attrs) {
      const v = el.getAttribute(a);
      if (v && v.length < 80) {
        const s = `${tag}[${a}="${v.replace(/"/g, '\\"')}"]`;
        if (unique(s)) return s;
      }
    }
    if (el.id && !/\d{3,}|:/.test(el.id) && unique(`#${cssEsc(el.id)}`)) return `#${cssEsc(el.id)}`;
    if (tag === 'video') return 'video';
    if (el.getAttribute('contenteditable') === 'true' && unique('[contenteditable="true"]')) return '[contenteditable="true"]';
    if (tag === 'input' && el.type === 'file') return unique('input[type="file"]') ? 'input[type="file"]' : pathSelector(el);
    return pathSelector(el);
  }
  function pathSelector(el) {
    const parts = [];
    while (el && el !== document.body && parts.length < 8) {
      let p = el.tagName.toLowerCase();
      const al = el.getAttribute('aria-label');
      if (al && al.length < 60) { parts.unshift(`${p}[aria-label="${al.replace(/"/g, '\\"')}"]`); break; }
      const sib = [...(el.parentElement?.children || [])].filter((c) => c.tagName === el.tagName);
      if (sib.length > 1) p += `:nth-of-type(${sib.indexOf(el) + 1})`;
      parts.unshift(p);
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  let picking = null;
  const hl = document.createElement('div');
  hl.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #4f8cff;background:#4f8cff22;display:none';
  document.documentElement.append(hl);
  function onMove(e) {
    const r = e.target.getBoundingClientRect();
    Object.assign(hl.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  }
  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    let el = e.target;
    if (picking === 'uploadInput' && !el.matches('input[type=file]')) {
      // ปุ่มแนบรูปมักซ่อน input[type=file] ไว้ใกล้ๆ — หาเฉพาะที่มีอยู่จริงบนหน้า
      const near = el.closest('form,div')?.querySelector('input[type=file]') || (document.querySelectorAll('input[type=file]').length === 1 ? document.querySelector('input[type=file]') : null);
      if (near) el = near;
    }
    if (picking === 'videoResult' && el.tagName !== 'VIDEO') el = el.closest('div')?.querySelector('video') || el;
    const selector = buildSelector(el);
    const role = picking;
    stopPicking();
    chrome.runtime.sendMessage({ type: 'pickedSelector', role, selector, matches: document.querySelectorAll(selector).length, tag: el.tagName.toLowerCase() });
    status(`บันทึก ${role} = ${selector}`);
  }
  function startPicking(role) {
    picking = role;
    status(`โหมดเลือก: คลิก "${globalThis.CLIP_SELECTOR_ROLES[role].label}" (Esc ยกเลิก)`);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
  }
  function stopPicking() {
    picking = null;
    hl.style.display = 'none';
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && picking) { stopPicking(); status('ยกเลิกโหมดเลือก'); } });

  // ---------- ข้อความจาก background ----------
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === 'ping') return reply({ ok: true });
    if (msg.type === 'abort') { abort = true; status('หยุดแล้ว'); return reply({ ok: true }); }
    if (msg.type === 'scanDom') return reply(scanDom());
    if (msg.type === 'pick') { startPicking(msg.role); return reply({ ok: true }); }
    if (msg.type === 'testSelectors') {
      const out = {};
      for (const [role, s] of Object.entries(msg.selectors || {})) {
        try { out[role] = s ? document.querySelectorAll(s).length : null; } catch { out[role] = 'invalid'; }
      }
      return reply(out);
    }
    if (msg.type === 'runJob') {
      // ตอบรับทันที แล้วส่งผลลัพธ์แยกทีหลัง (service worker อาจถูกปลุกใหม่ระหว่างรอ)
      reply({ accepted: true });
      runJob(msg.job, msg.cfg)
        .catch((e) => ({ ok: false, error: e.message, quota: Boolean(e.quota), aborted: abort }))
        .then((result) => chrome.runtime.sendMessage({ type: 'jobResult', job: msg.job, result }));
      return;
    }
  });
})();
