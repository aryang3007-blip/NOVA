@echo off
chcp 65001 >nul
title AURA Launcher
c:\aryan\env\Scripts\Activate.ps1         
cd /d "%~dp0aura"
python server\serve.py --allow-actions --allow-lan