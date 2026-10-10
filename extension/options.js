const ta = document.getElementById('json');
const msg = document.getElementById('msg');

chrome.runtime.sendMessage({ type: 'getState' }).then(({ cfg }) => {
  ta.value = JSON.stringify(cfg, null, 2);
});

document.getElementById('save').onclick = async () => {
  try {
    const patch = JSON.parse(ta.value);
    await chrome.runtime.sendMessage({ type: 'saveCfg', patch });
    msg.textContent = '✅ บันทึกแล้ว';
  } catch (e) {
    msg.textContent = '❌ JSON ไม่ถูกต้อง: ' + e.message;
  }
};
