@echo off
rem ============================================================
rem  agent-hub 一键打开（双击即可）
rem  作用：确保后台服务在运行，然后用（带本地 key 的）地址打开浏览器。
rem  本脚本不包含任何密钥；key 在运行时从 keys\hub.key 读取。
rem ============================================================
setlocal
set "ROOT=%~dp0"
set "STARTER=%ROOT%scripts\start.ps1"

echo [1/2] 正在确保 agent-hub 服务运行...
powershell -NoProfile -ExecutionPolicy Bypass -File "%STARTER%"

echo.
echo [2/2] 正在打开仪表盘...
if not exist "%ROOT%keys\hub.key" (
  echo [错误] 未找到 keys\hub.key，请先运行一次 scripts\start.ps1 生成。
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$k=(Get-Content '%ROOT%keys\hub.key' -Raw).Trim(); Start-Process ('http://127.0.0.1:39310/?key=' + $k)"

echo 已在浏览器中打开：http://127.0.0.1:39310/?key=****
timeout /t 3 >nul
endlocal
