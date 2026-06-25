#!/bin/bash
# NGワードゲーム ワンクリック起動スクリプト
# ダブルクリックすると: ゲームサーバ + 公開トンネルを起動し、共有URLを表示します。

cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.local/node/bin:$PATH"

echo "=========================================="
echo "  NGワードゲーム を起動します"
echo "=========================================="

# 既存のプロセスがあれば停止
pkill -f "node server.js" 2>/dev/null
pkill -f "cloudflared tunnel" 2>/dev/null
sleep 1

# ① ゲームサーバ起動（バックグラウンド）
echo "▶ ゲームサーバを起動中..."
node server.js > /tmp/nggame.log 2>&1 &
SERVER_PID=$!
sleep 2

if ! curl -s -o /dev/null http://localhost:3000/ ; then
  echo "✖ サーバ起動に失敗しました。/tmp/nggame.log を確認してください。"
  echo "  （Node.js が見つからない場合は https://nodejs.org からインストール）"
  read -r -p "Enterキーで閉じます"
  exit 1
fi
echo "  → ローカル: http://localhost:3000"

# ② 公開トンネル起動（バックグラウンド）
echo "▶ 公開トンネルを起動中（数秒お待ちください）..."
~/.local/bin/cloudflared tunnel --url http://localhost:3000 > /tmp/cf.log 2>&1 &
TUNNEL_PID=$!

# URLが出るまで待つ（最大20秒）
URL=""
for i in $(seq 1 20); do
  URL=$(grep -Eo "https://[a-z0-9-]+\.trycloudflare\.com" /tmp/cf.log | head -1)
  [ -n "$URL" ] && break
  sleep 1
done

echo ""
echo "=========================================="
if [ -n "$URL" ]; then
  echo "  ✅ 準備完了！ 友達にこのURLを共有:"
  echo ""
  echo "     $URL"
  echo ""
  # URLをクリップボードにコピー
  printf "%s" "$URL" | pbcopy 2>/dev/null && echo "  （URLはクリップボードにコピー済み）"
else
  echo "  ⚠ 公開URLの取得に失敗しました。/tmp/cf.log を確認してください。"
  echo "    ローカルなら http://localhost:3000 で遊べます。"
fi
echo "=========================================="
echo ""
echo "★ このウインドウは閉じないでください（閉じるとゲームが止まります）"
echo "★ 停止するには Ctrl + C を押すか、このウインドウを閉じてください"
echo ""

# Ctrl+C やウインドウ終了時に両プロセスを停止
trap 'echo "停止中..."; kill $SERVER_PID $TUNNEL_PID 2>/dev/null; exit 0' INT TERM

# プロセスが生きている間ここで待機
wait
