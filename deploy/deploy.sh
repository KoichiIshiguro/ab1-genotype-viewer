#!/usr/bin/env bash
# 手元からサーバー（ssh salty）へ公開ファイルを同期する。
#   bash deploy/deploy.sh
# 初回のみ、同期後にサーバー側で setup-vhost.sh を1回実行する（HTTPS化）。
set -euo pipefail

HOST="ab1-snp.app.saltybullet.com"
SSH="salty"
ROOT="/var/www/${HOST}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

ssh "$SSH" "mkdir -p ${ROOT}"
rsync -az --delete \
  --exclude '.git' --exclude '.gitignore' --exclude '.upload-files' --exclude 'test' \
  --exclude 'README.md' --exclude 'package.json' \
  --exclude '*.ab1' --exclude '*.abi' --exclude '*.xlsx' \
  --exclude 'stats/data-*.json' \
  "${HERE}/" "${SSH}:${ROOT}/"

echo "同期しました: ${SSH}:${ROOT}"
echo "初回のみ: ssh ${SSH} 'sudo bash ${ROOT}/deploy/setup-vhost.sh'"
