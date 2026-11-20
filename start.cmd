@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动直播源本地缓冲代理...
node proxy.js
pause
