@echo off
REM Native UDP relay for the Windows base station.
REM Binds LAN port 5005 and forwards the car's telemetry into the container's
REM published UDP port (127.0.0.1:15005 - see docker-compose.windows-base.yml).
REM Pure PowerShell, no Python needed. Keep this window open for the whole
REM session; close it / Ctrl+C to stop.

setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows-udp-relay.ps1" %*

echo.
echo Relay exited. Press any key to close.
pause >nul
endlocal
