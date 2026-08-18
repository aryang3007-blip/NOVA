@echo off
chcp 65001 >nul
title AURA Launcher
cd /d "%~dp0aura"
python serve.py --allow-actions --allow-lan