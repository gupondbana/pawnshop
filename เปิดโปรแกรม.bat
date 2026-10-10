@echo off
chcp 65001 >nul
title Clip Studio (ห้ามปิดหน้าต่างนี้ระหว่างใช้งาน)
cd /d "%~dp0studio"
where node >nul 2>nul
if errorlevel 1 (
  echo [!] ยังไม่ได้ติดตั้ง ให้ดับเบิลคลิก "ติดตั้งครั้งแรก.bat" ก่อน
  echo     ถ้าเพิ่งติดตั้งเสร็จ ให้รีสตาร์ทเครื่อง 1 ครั้ง
  pause
  exit /b 1
)
if exist "%~dp0api-key.txt" set /p ANTHROPIC_API_KEY=<"%~dp0api-key.txt"
if not defined SUB_FONT set SUB_FONT=Leelawadee UI
echo กำลังเปิด Clip Studio ... (ย่อหน้าต่างนี้ไว้ได้ แต่ห้ามปิด)
start "" http://127.0.0.1:4317
node server.js
pause
