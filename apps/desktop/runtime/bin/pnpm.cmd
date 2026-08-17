@echo off
setlocal
set "PNPM_ENTRY=%~dp0..\node_modules\pnpm\bin\pnpm.mjs"
if defined DSH_DESKTOP_NODE (
  "%DSH_DESKTOP_NODE%" "%PNPM_ENTRY%" %*
) else (
  node.exe "%PNPM_ENTRY%" %*
)
exit /b %ERRORLEVEL%
