@echo off
chcp 65001 >nul
title Clip Studio - ติดตั้งครั้งแรก
echo ==========================================
echo   Clip Studio : ติดตั้งโปรแกรมที่จำเป็น
echo   (ทำครั้งเดียว ใช้เวลาประมาณ 5-10 นาที)
echo ==========================================
echo.
where winget >nul 2>nul
if errorlevel 1 (
  echo [!] เครื่องนี้ไม่มี winget กรุณาอัปเดต Windows หรือติดตั้ง "App Installer" จาก Microsoft Store แล้วลองใหม่
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo [1/2] กำลังติดตั้ง Node.js ...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
) else (
  echo [1/2] มี Node.js แล้ว
)
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo [2/2] กำลังติดตั้ง FFmpeg ...
  winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
) else (
  echo [2/2] มี FFmpeg แล้ว
)
echo.
echo ==========================================
echo   เสร็จแล้ว! ปิดหน้าต่างนี้ แล้วดับเบิลคลิก "เปิดโปรแกรม.bat"
echo ==========================================
pause
