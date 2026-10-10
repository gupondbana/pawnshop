const $ = (s) => document.querySelector(s);
const send = (msg) => chrome.runtime.sendMessage(msg);
let counts = {};

async function refresh() {
  const { run, cfg } = await send({ type: 'getState' });
  $('#status').textContent = `${run.running ? '🟢 ทำงาน' : '⚪ หยุด'}${run.job ? ` · ${run.job.title}` : ''}\n${run.text || ''}`;
  $('#roles').innerHTML = '';
  for (const [role, meta] of Object.entries(CLIP_SELECTOR_ROLES)) {
    const row = document.createElement('div');
    row.className = 'row';
    const val = cfg.selectors[role];
    row.innerHTML = `<span style="width:110px">${meta.required ? '<span class="req">*</span>' : ''}${role}</span>
      <span class="sel" title=""></span><span class="count"></span>`;
    row.querySelector('.sel').textContent = val || '(ยังไม่ตั้ง)';
    row.querySelector('.sel').title = `${meta.label}\n${val || ''}`;
    row.querySelector('.count').textContent = role in counts ? `×${counts[role] ?? '-'}` : '';
    const b = document.createElement('button');
    b.className = 'ghost';
    b.textContent = 'เลือก';
    b.onclick = async () => { await send({ type: 'pick', role }); window.close(); };
    row.append(b);
    $('#roles').append(row);
  }
}

$('#start').onclick = () => send({ type: 'start' }).then(refresh);
$('#stop').onclick = () => send({ type: 'stop' }).then(refresh);
$('#studio').onclick = () => chrome.tabs.create({ url: 'http://127.0.0.1:4317/' });
$('#opts').onclick = () => chrome.runtime.openOptionsPage();
$('#test').onclick = async () => { counts = (await send({ type: 'testSelectors' })) || {}; refresh(); };
$('#scan').onclick = async () => {
  const r = await send({ type: 'scanDom' });
  $('#status').textContent = r.ok ? `ส่งโครงสร้างหน้าแล้ว: ${r.count} องค์ประกอบ, file input ${r.fileInputs} อัน\nดูได้ที่ studio/data/dom/` : `❌ ${r.error}`;
};
$('#perm').onclick = async () => {
  const ok = await chrome.permissions.request({ origins: ['https://*/*'] });
  $('#status').textContent = ok ? 'ได้สิทธิ์ดาวน์โหลดแล้ว' : 'ไม่ได้รับสิทธิ์';
};

chrome.runtime.onMessage.addListener((m) => { if (m.type === 'runUpdate' || m.type === 'picked') refresh(); });
refresh();
