#!/usr/bin/env bash
# ab1-snp.app.saltybullet.com の vhost を設置して HTTPS 化する。
# サーバー上で1回だけ実行する:
#   sudo bash /var/www/ab1-snp.app.saltybullet.com/deploy/setup-vhost.sh
set -euo pipefail

HOST="ab1-snp.app.saltybullet.com"
ROOT="/var/www/${HOST}"
SRC="${ROOT}/deploy/${HOST}.conf"

[ "$(id -u)" -eq 0 ] || { echo "root で実行してください（sudo bash $0）"; exit 1; }
[ -f "$SRC" ] || { echo "vhost定義が見つかりません: $SRC"; exit 1; }

a2enmod -q deflate headers rewrite ssl auth_basic authn_file authz_user || true
install -m 644 "$SRC" "/etc/apache2/sites-available/${HOST}.conf"
a2ensite -q "${HOST}.conf"
apache2ctl configtest
systemctl reload apache2

# Let's Encrypt 証明書を取得し、HTTP→HTTPS リダイレクトまで設定する
certbot --apache -d "$HOST" -n --agree-tos --redirect

apache2ctl configtest
systemctl reload apache2

# アクセスログ集計(deploy/stats.py)を sudo なしで回せるようにする。
# /var/log/apache2 は root:adm 0750、ログファイルは 0640 root:adm のため adm 参加で読める。
if ! id -nG saltybullet | tr ' ' '\n' | grep -qx adm; then
    usermod -aG adm saltybullet
    echo "saltybullet を adm グループに追加しました（次回ログインから有効）"
fi

echo "完了: https://${HOST}/"
echo "統計の確認: ssh salty 'python3 ${ROOT}/deploy/stats.py'"
echo "統計ページ : https://${HOST}/stats/  （ログイン情報: deploy/set-password.sh、JSON更新: deploy/refresh-stats.sh --install）"
