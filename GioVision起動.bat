@echo off
chcp 65001 > nul
cd /d "%~dp0"

echo ==========================================
echo   GioVision Hiroshima 起動中...
echo ==========================================

REM Node.js の確認 (ポータブル版 node\node.exe または システムの node)
set NODE_EXE=node
if exist "..\node\node.exe" (
    set NODE_EXE=..\node\node.exe
) else if exist "node\node.exe" (
    set NODE_EXE=node\node.exe
)

where %NODE_EXE% >nul 2>nul
if %errorlevel% neq 0 (
    echo [エラー] Node.js が見つかりませんでした。
    echo Node.js をインストールするか、node フォルダに node.exe を配置してください。
    pause
    exit /b 1
)

REM ポート5500の確認 (netstat)
netstat -ano | findstr ":5500 " | findstr "LISTENING" >nul 2>nul
if %errorlevel% neq 0 (
    echo ローカルサーバー (server.js) を起動しています...
    start "GioVision サーバー" /min %NODE_EXE% server.js
    timeout /t 2 /nobreak > nul
) else (
    echo ローカルサーバーは既に起動しています。
)

echo ブラウザで GioVision Hiroshima を開きます...
start http://localhost:5500
