// Selector ของหน้า Meta — ตั้งใจเว้นว่างไว้ทั้งหมด ห้ามเดา
// ผู้ใช้ต้องเปิดหน้า Meta จริงแล้วใช้ "โหมดเลือก Selector" ใน popup คลิกองค์ประกอบจริงเพื่อบันทึก
// ค่าที่บันทึกจะอยู่ใน chrome.storage.local.selectors และแก้ด้วยมือได้ในหน้า Options
globalThis.CLIP_SELECTOR_ROLES = {
  newChat:      { required: false, label: 'ปุ่มเริ่มแชต/งานใหม่ (ถ้ามี)' },
  promptInput:  { required: true,  label: 'ช่องพิมพ์ Prompt' },
  uploadInput:  { required: false, label: 'input[type=file] สำหรับแนบรูป (หรือปุ่มแนบรูป)' },
  submitButton: { required: true,  label: 'ปุ่มส่ง/สร้าง' },
  videoResult:  { required: true,  label: 'วิดีโอผลลัพธ์ (<video>)' },
  modeButton:   { required: false, label: 'ปุ่มเลือกโหมด (รูป/วิดีโอ)' },
  busyIndicator:{ required: false, label: 'สัญลักษณ์กำลังสร้าง (ถ้ามี)' },
};

// ข้อความที่แปลว่าโควตาหมด/ถูกจำกัด — ให้ผู้ใช้กรอกจากข้อความจริงที่เห็นบนหน้า (เว้นว่างไว้)
globalThis.CLIP_DEFAULT_QUOTA_TEXTS = [];
