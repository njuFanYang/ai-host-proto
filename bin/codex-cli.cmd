@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0..\scripts\start-managed.ps1" cli %*
