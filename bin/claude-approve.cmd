@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0..\scripts\decide-approval.ps1" %*
