@echo off
set SCRIPT_DIR=%~dp0
node "%SCRIPT_DIR%..\src\wrapper\codex-wrapper.js" %*
