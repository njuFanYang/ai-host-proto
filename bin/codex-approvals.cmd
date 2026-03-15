@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0..\scripts\watch-approvals.ps1" %*
