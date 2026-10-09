@echo off
rem Starts serve.ps1 next to this file; see the comment at the top of serve.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" %*
