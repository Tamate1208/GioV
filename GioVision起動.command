#!/bin/bash
cd "$(dirname "$0")"
echo "=========================================="
echo "  GioVision Hiroshima を起動しています..."
echo "=========================================="

# ポート5500が起動しているか確認し、起動していなければ server.js を起動
if ! lsof -i :5500 > /dev/null 2>&1; then
    echo "ローカルサーバー (server.js) を起動中..."
    node server.js &
    sleep 1
else
    echo "ローカルサーバーは既に起動しています。"
fi

# ブラウザを自動で開く
echo "ブラウザで GioVision Hiroshima を開きます..."
open http://localhost:5500

