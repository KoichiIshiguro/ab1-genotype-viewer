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

a2enmod -q deflate headers rewrite ssl || true
install -m 644 "$SRC" "/etc/apache2/sites-available/${HOST}.conf"
a2ensite -q "${HOST}.conf"
apache2ctl configtest
systemctl reload apache2

# Let's Encrypt 証明書を取得し、HTTP→HTTPS リダイレクトまで設定する
certbot --apache -d "$HOST" -n --agree-tos --redirect

apache2ctl configtest
systemctl reload apache2
echo "完了: https://${HOST}/"
