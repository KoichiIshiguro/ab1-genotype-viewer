#!/usr/bin/env bash
# 統計閲覧ページ(/stats/)のログイン情報を設定する。サーバー上で実行する（sudo 不要）。
#   bash /var/www/ab1-snp.app.saltybullet.com/deploy/set-password.sh <ユーザー名>
# パスワードは対話的に聞かれる。環境変数 PASSWORD を渡せば非対話で設定できる。
# 認証ファイルは公開ディレクトリの外 (/var/www/ab1-snp-stats/htpasswd) に置く。
set -euo pipefail

AUTH_DIR="/var/www/ab1-snp-stats"
AUTH_FILE="${AUTH_DIR}/htpasswd"
USER_NAME="${1:-}"
[ -n "$USER_NAME" ] || { echo "使い方: $0 <ユーザー名>"; exit 1; }

mkdir -p "$AUTH_DIR"
chmod 755 "$AUTH_DIR"

# -B: bcrypt。ファイルが無ければ -c で新規作成、あれば該当ユーザーだけ更新する
if [ -n "${PASSWORD:-}" ]; then
    if [ -f "$AUTH_FILE" ]; then htpasswd -B -b "$AUTH_FILE" "$USER_NAME" "$PASSWORD"
    else htpasswd -B -b -c "$AUTH_FILE" "$USER_NAME" "$PASSWORD"; fi
else
    if [ -f "$AUTH_FILE" ]; then htpasswd -B "$AUTH_FILE" "$USER_NAME"
    else htpasswd -B -c "$AUTH_FILE" "$USER_NAME"; fi
fi
# Apache(www-data) が読めて、他のユーザーには見せない
chmod 644 "$AUTH_FILE"
echo "設定しました: ${AUTH_FILE} （ユーザー: ${USER_NAME}）"
cut -d: -f1 "$AUTH_FILE" | sed 's/^/  登録済みユーザー: /'
