@echo off
chcp 65001 >nul
title QQ Codex Bot
cd /d "%~dp0"
rem Supervisor: restarts the bot after crashes, stops on config/credential errors
node scripts\supervisor.ts
pause
