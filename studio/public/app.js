// UI ของ Studio: สร้างโปรเจกต์ → AI เขียนบท → ตรวจแก้ Storyboard → ส่งเข้าคิว → รวมคลิป
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(method, url, body, raw) {
  const res = await fetch(url, {
    method,
    headers: raw ? {} : { 'content-type': 'application/json' },
    body: raw ? body : body && JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let current = null; // โปรเจกต์ที่เปิดอยู่
let dirty = false;

// ---------- โปรเจกต์ ----------
async function loadList() {
  const list = await api('GET', '/api/projects');
  $('#projectList').innerHTML = list.map((p) => `
    <li data-id="${p.id}" class="${current?.id === p.id ? 'active' : ''}">
      <div>${esc(p.title)}</div>
      <small class="muted">${esc(p.type)} · ${p.scenes.filter((s) => s.video).length}/${p.scenes.length} ฉาก</small>
    </li>`).join('');
}
$('#projectList').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li) openProject(li.dataset.id);
});

$('#newForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const p = await api('POST', '/api/projects', {
    type: f.get('type'), topic: f.get('topic'), details: f.get('details'),
    links: String(f.get('links')).split('\n').map((s) => s.trim()).filter(Boolean),
  });
  for (const file of e.target.images.files) {
    await api('POST', `/api/projects/${p.id}/images?name=${encodeURIComponent(file.name)}`, file, true);
  }
  e.target.reset();
  await openProject(p.id);
});

async function openProject(id) {
  if (dirty && current && !confirm('มีการแก้ไขที่ยังไม่บันทึก ทิ้งหรือไม่?')) return;
  current = await api('GET', `/api/projects/${id}`);
  dirty = false;
  render();
  loadList();
}

// ---------- Editor ----------
function render() {
  const p = current;
  const imgs = p.input.images;
  const chars = p.characters;
  $('#editor').innerHTML = `
    <div class="row" style="justify-content:space-between">
      <input id="title" value="${esc(p.title)}" style="max-width:420px;font-size:16px">
      <div class="row">
        <button id="save">💾 บันทึก</button>
        <button class="ghost" id="reload">↻ โหลดใหม่</button>
      </div>
    </div>

    <div class="card">
      <h3>1. ข้อมูลตั้งต้น</h3>
      <div class="grid2">
        <label>หัวข้อ <input data-in="topic" value="${esc(p.input.topic)}"></label>
        <label>ลิงก์ <input data-in="links" value="${esc(p.input.links.join(' '))}"></label>
      </div>
      <label>รายละเอียด <textarea data-in="details" rows="2">${esc(p.input.details)}</textarea></label>
      <div class="thumbs">${imgs.map((i) => `<img src="/files/${p.id}/${i}" title="${esc(i)}">`).join('')}</div>
      <div class="row">
        <label style="width:auto">จำนวนฉาก <input id="sceneCount" type="number" min="1" max="15" value="${p.scenes.length || 6}" style="width:70px"></label>
        <button id="gen">✨ ให้ AI เขียนบท + แบ่งฉาก</button>
        <span id="genMsg" class="muted"></span>
      </div>
    </div>

    <div class="card">
      <h3>2. บท</h3>
      <div class="grid2">
        <label>Hook <textarea data-script="hook" rows="2">${esc(p.script?.hook)}</textarea></label>
        <label>ตอนจบ <textarea data-script="ending" rows="2">${esc(p.script?.ending)}</textarea></label>
      </div>
      <label>เนื้อหา <textarea data-script="body" rows="3">${esc(p.script?.body)}</textarea></label>
      <div class="grid2">
        <label>Caption <textarea data-script="caption" rows="2">${esc(p.script?.caption)}</textarea></label>
        <label>แฮชแท็ก <input data-script="hashtags" value="${esc((p.script?.hashtags || []).join(' '))}"></label>
      </div>
    </div>

    <div class="card">
      <h3>3. ตัวละคร <small class="muted">(ใช้ look เดียวกันทุก Prompt เพื่อให้หน้าตาต่อเนื่อง)</small></h3>
      ${chars.map((c, i) => `
        <div class="grid2" data-char="${i}">
          <label>ชื่อ (${esc(c.id)}) <input data-c="name" value="${esc(c.name)}"></label>
          <label>เสียง <input data-c="voice" value="${esc(c.voice)}"></label>
        </div>
        <label>Look (อังกฤษ) <textarea data-char="${i}" data-c="look" rows="2">${esc(c.look)}</textarea></label>`).join('') || '<p class="muted">ยังไม่มี</p>'}
    </div>

    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h3>4. Storyboard</h3>
        <div class="row">
          <button class="ghost" id="addScene">+ เพิ่มฉาก</button>
          <button id="enqueueAll">▶ ส่งทุกฉากเข้าคิว</button>
          <button class="ghost" id="dequeueAll">⏹ เอาออกจากคิว</button>
        </div>
      </div>
      ${p.scenes.map((s, i) => sceneHtml(p, s, i)).join('') || '<p class="muted">กด “ให้ AI เขียนบท” ก่อน</p>'}
    </div>

    <div class="card final">
      <h3>5. รวมคลิปและส่งออก</h3>
      <div class="row">
        <label style="width:auto">Transition
          <select id="transition">${['fade', 'fadeblack', 'slideleft', 'slideup', 'circleopen', 'none'].map((t) => `<option ${p.settings.transition === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
        </label>
        <label style="width:auto"><input type="checkbox" id="burnSubs" ${p.settings.burnSubtitles !== false ? 'checked' : ''} style="width:auto"> เผาซับ</label>
        <label style="width:auto"><input type="checkbox" id="titleOverlay" ${p.settings.titleOverlay !== false ? 'checked' : ''} style="width:auto"> ข้อความ Hook ต้นคลิป</label>
        <button id="renderBtn">🎞 รวมเป็น MP4 9:16</button>
        <span id="renderMsg" class="muted"></span>
      </div>
      ${p.lastRender ? `<p><a href="/files/${p.id}/${p.lastRender.video}" download>⬇ ${esc(p.lastRender.video)}</a> · <a href="/files/${p.id}/${p.lastRender.caption}" target="_blank">caption.txt</a></p>
        <video controls src="/files/${p.id}/${p.lastRender.video}" style="max-width:280px"></video>` : ''}
    </div>`;
  bindEditor();
}

function sceneHtml(p, s, i) {
  const opts = ['<option value="">— ไม่ใช้รูป —</option>', ...p.input.images.map((im) => `<option value="${esc(im)}" ${s.refImage === im ? 'selected' : ''}>${esc(im.split('/').pop())}</option>`)].join('');
  return `
  <div class="card scene" data-scene="${i}">
    <div>
      <div class="row" style="justify-content:space-between">
        <strong>ฉาก ${i + 1}</strong>
        <span class="badge ${s.status}">${esc(s.status)}</span>
        <span class="muted">${esc(s.statusMessage)}</span>
        <div class="row">
          <button class="ghost" data-act="up">↑</button><button class="ghost" data-act="down">↓</button>
          <button class="ghost" data-act="queue">▶ คิวฉากนี้</button>
          <button class="ghost danger" data-act="del">ลบ</button>
        </div>
      </div>
      <div class="grid2">
        <label>ภาพ/ฉาก <textarea data-f="visual" rows="2">${esc(s.visual)}</textarea></label>
        <label>บทพูด/บรรยาย <textarea data-f="dialogue" rows="2">${esc(s.dialogue)}</textarea></label>
      </div>
      <label>ซับ <input data-f="subtitle" value="${esc(s.subtitle)}"></label>
      <label>Prompt สำหรับ Meta <textarea data-f="prompt" rows="3">${esc(s.prompt)}</textarea></label>
      <div class="row">
        <label style="width:auto">ความยาว(วิ) <input data-f="duration" type="number" value="${s.duration}" style="width:70px"></label>
        <label style="width:auto">รูปอ้างอิง <select data-f="refImage">${opts}</select></label>
        <label style="width:auto"><input type="checkbox" data-f="muteOriginal" ${s.muteOriginal ? 'checked' : ''} style="width:auto"> ปิดเสียง Meta</label>
        <label style="width:auto">TTS สำรอง <input type="file" accept="audio/*" data-upload="tts" style="width:180px"></label>
        ${s.ttsAudio ? `<audio controls src="/files/${p.id}/${s.ttsAudio}" style="height:30px"></audio><button class="ghost" data-act="rmtts">ลบ TTS</button>` : ''}
        <label style="width:auto">อัปวิดีโอเอง <input type="file" accept="video/*" data-upload="video" style="width:180px"></label>
      </div>
    </div>
    <div>${s.video ? `<video controls src="/files/${p.id}/${s.video}"></video>` : '<p class="muted">ยังไม่มีวิดีโอ</p>'}</div>
  </div>`;
}

// รวบรวมค่าจากฟอร์มกลับเข้า current
function collect() {
  const p = current;
  p.title = $('#title').value;
  p.input.topic = $('[data-in=topic]').value;
  p.input.details = $('[data-in=details]').value;
  p.input.links = $('[data-in=links]').value.split(/\s+/).filter(Boolean);
  p.script = p.script || {};
  document.querySelectorAll('[data-script]').forEach((el) => {
    p.script[el.dataset.script] = el.dataset.script === 'hashtags' ? el.value.split(/\s+/).filter(Boolean) : el.value;
  });
  document.querySelectorAll('[data-c]').forEach((el) => {
    const i = el.closest('[data-char]')?.dataset.char ?? el.dataset.char;
    p.characters[i][el.dataset.c] = el.value;
  });
  document.querySelectorAll('[data-scene]').forEach((card) => {
    const s = p.scenes[card.dataset.scene];
    card.querySelectorAll('[data-f]').forEach((el) => {
      const k = el.dataset.f;
      s[k] = el.type === 'checkbox' ? el.checked : k === 'duration' ? Number(el.value) : k === 'refImage' ? el.value || null : el.value;
    });
  });
  p.settings.transition = $('#transition').value;
  p.settings.burnSubtitles = $('#burnSubs').checked;
  p.settings.titleOverlay = $('#titleOverlay').checked;
}

async function save() {
  collect();
  current = await api('PUT', `/api/projects/${current.id}`, current);
  dirty = false;
  render();
  loadList();
}

function bindEditor() {
  const ed = $('#editor');
  ed.oninput = () => (dirty = true);
  $('#save').onclick = save;
  $('#reload').onclick = () => { dirty = false; openProject(current.id); };

  $('#gen').onclick = async () => {
    if (current.scenes.some((s) => s.video) && !confirm('การสร้างบทใหม่จะแทนที่ฉากเดิมทั้งหมด ดำเนินการต่อ?')) return;
    const sceneCount = Number($('#sceneCount').value); // อ่านก่อน save() เพราะ save() วาดหน้าใหม่และรีเซ็ตช่องนี้
    await save();
    $('#genMsg').textContent = 'AI กำลังเขียนบท...';
    try {
      current = await api('POST', `/api/projects/${current.id}/generate`, { sceneCount });
      render();
      loadList();
    } catch (e) { $('#genMsg').textContent = '❌ ' + e.message; }
  };

  $('#addScene').onclick = () => {
    collect();
    current.scenes.push({ duration: 5, visual: '', dialogue: '', subtitle: '', prompt: '', refImage: null, muteOriginal: false, status: 'draft', statusMessage: '' });
    dirty = true;
    render();
  };
  $('#enqueueAll').onclick = async () => { await save(); current = await api('POST', `/api/projects/${current.id}/enqueue`, {}); render(); };
  $('#dequeueAll').onclick = async () => { current = await api('POST', `/api/projects/${current.id}/dequeue`, {}); render(); };

  ed.querySelectorAll('[data-scene]').forEach((card) => {
    const i = Number(card.dataset.scene);
    card.onclick = async (e) => {
      const act = e.target.dataset.act;
      if (!act) return;
      if (act === 'queue') {
        await save();
        current = await api('POST', `/api/projects/${current.id}/enqueue`, { sceneIds: [current.scenes[i].id] });
        return render();
      }
      if (act === 'rmtts') {
        current = await api('DELETE', `/api/projects/${current.id}/scenes/${current.scenes[i].id}/tts`);
        return render();
      }
      collect();
      const sc = current.scenes;
      if (act === 'del' && confirm('ลบฉากนี้?')) sc.splice(i, 1);
      if (act === 'up' && i > 0) [sc[i - 1], sc[i]] = [sc[i], sc[i - 1]];
      if (act === 'down' && i < sc.length - 1) [sc[i + 1], sc[i]] = [sc[i], sc[i + 1]];
      await save();
    };
    card.querySelectorAll('[data-upload]').forEach((input) => {
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;
        await save();
        const sid = current.scenes[i].id;
        current = await api('POST', `/api/projects/${current.id}/scenes/${sid}/${input.dataset.upload}?name=${encodeURIComponent(file.name)}`, file, true);
        render();
      };
    });
  });

  $('#renderBtn').onclick = async () => {
    await save();
    try {
      await api('POST', `/api/projects/${current.id}/render`);
      pollRender(current.id);
    } catch (e) { $('#renderMsg').textContent = '❌ ' + e.message; }
  };
}

async function pollRender(id) {
  const r = await api('GET', `/api/projects/${id}/render`);
  if (current?.id !== id) return;
  $('#renderMsg').textContent = r.status === 'failed' ? '❌ ' + r.message : r.message || '';
  if (r.status === 'running') return setTimeout(() => pollRender(id), 1000);
  if (r.status === 'done') openProject(id);
}

// ---------- แถบสถานะคิว (อัปเดตทุก 3 วิ) ----------
async function refreshQueue() {
  try {
    const q = await api('GET', '/api/queue');
    $('#queueBar').innerHTML = `
      <span>${q.paused ? `⏸ คิวหยุด: ${esc(q.pauseReason)}` : q.active ? `🔄 กำลังทำ ${esc(q.active.sceneId)}` : '🟢 คิวพร้อม'}</span>
      ${q.paused ? '<button id="resumeQ">ทำต่อ</button>' : '<button class="danger" id="pauseQ">หยุดคิว</button>'}`;
    $('#pauseQ')?.addEventListener('click', () => api('POST', '/api/queue/pause', { reason: 'ผู้ใช้กดหยุด' }).then(refreshQueue));
    $('#resumeQ')?.addEventListener('click', () => api('POST', '/api/queue/resume').then(refreshQueue));
    // รีเฟรชสถานะฉากถ้าไม่ได้แก้อะไรค้างอยู่
    if (current && !dirty && document.activeElement?.tagName !== 'TEXTAREA') {
      const p = await api('GET', `/api/projects/${current.id}`);
      if (p.updatedAt !== current.updatedAt) { current = p; render(); }
    }
  } catch { $('#queueBar').textContent = '⚠ ติดต่อ Studio ไม่ได้'; }
}
setInterval(refreshQueue, 3000);
refreshQueue();
loadList();
