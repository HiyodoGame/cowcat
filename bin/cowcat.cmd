@echo off
rem CowCat global launcher shim for Windows (cmd): resolves the repo from
rem this script's own location; add <repo>\bin to PATH for a global cowcat.
setlocal
set "DIR=%~dp0"
node "%DIR%..\agent\bin\cowcat.mjs" %*
exit /b %ERRORLEVEL%
