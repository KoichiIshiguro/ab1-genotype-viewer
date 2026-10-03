#!/usr/bin/env bash
# deploy/<host>.conf を変更したあと、サーバー上の Apache 設定（HTTP用と certbot が作った HTTPS用の両方）
# に反映する。setup-vhost.sh は初回用で、2回目以降の設定変更はこれを使う。
#   sudo bash /var/www/ab1-snp.app.saltybullet.com/deploy/update-vhost.sh
#
# certbot が生成した -le-ssl.conf は :80 の conf のコピーに証明書の3行を足したものなので、
# ここでも同じ構造を deploy/<host>.conf から作り直す。
set -euo pipefail

HOST="ab1-snp.app.saltybullet.com"
ROOT="/var/www/${HOST}"
SRC="${ROOT}/deploy/${HOST}.conf"
HTTP_CONF="/etc/apache2/sites-available/${HOST}.conf"
SSL_CONF="/etc/apache2/sites-available/${HOST}-le-ssl.conf"
CERT="/etc/letsencrypt/live/${HOST}/fullchain.pem"

[ "$(id -u)" -eq 0 ] || { echo "root で実行してください（sudo bash $0）"; exit 1; }
[ -f "$SRC" ]  || { echo "vhost定義が見つかりません: $SRC"; exit 1; }
[ -f "$CERT" ] || { echo "証明書がまだありません: $CERT  → 先に setup-vhost.sh を実行してください"; exit 1; }

# 戻せるように現状を残す
STAMP="$(date +%Y%m%d-%H%M%S)"
[ -f "$HTTP_CONF" ] && cp -p "$HTTP_CONF" "${HTTP_CONF}.bak-${STAMP}"
[ -f "$SSL_CONF" ]  && cp -p "$SSL_CONF"  "${SSL_CONF}.bak-${STAMP}"

python3 - "$SRC" "$HOST" "$HTTP_CONF" "$SSL_CONF" <<'PY'
import sys, io
src, host, http_conf, ssl_conf = sys.argv[1:]
body = io.open(src, encoding='utf-8').read().rstrip('\n')
assert body.count('<VirtualHost *:80>') == 1 and body.endswith('</VirtualHost>'), 'deploy conf の構造が想定と違います'

# HTTP: 末尾に certbot --redirect と同じ HTTP→HTTPS リダイレクトを付ける
redirect = ('RewriteCond %%{SERVER_NAME} =%s\n'
            'RewriteRule ^ https://%%{SERVER_NAME}%%{REQUEST_URI} [END,NE,R=permanent]\n') % host
http_text = body[:-len('</VirtualHost>')] + redirect + '</VirtualHost>\n'

# HTTPS: *:443 に変え、証明書の3行を足し、mod_ssl があるときだけ有効にする
ssl_lines = ('\nSSLCertificateFile /etc/letsencrypt/live/%s/fullchain.pem\n'
             'SSLCertificateKeyFile /etc/letsencrypt/live/%s/privkey.pem\n'
             'Include /etc/letsencrypt/options-ssl-apache.conf\n') % (host, host)
ssl_body = body.replace('<VirtualHost *:80>', '<VirtualHost *:443>', 1)
ssl_text = '<IfModule mod_ssl.c>\n' + ssl_body[:-len('</VirtualHost>')] + ssl_lines + '</VirtualHost>\n</IfModule>\n'

io.open(http_conf, 'w', encoding='utf-8').write(http_text)
io.open(ssl_conf, 'w', encoding='utf-8').write(ssl_text)
print('書き込み: %s\n書き込み: %s' % (http_conf, ssl_conf))
PY
chmod 644 "$HTTP_CONF" "$SSL_CONF"

a2enmod -q deflate headers rewrite ssl auth_basic authn_file authz_user || true
if apache2ctl configtest; then
    systemctl reload apache2
else
    echo "configtest に失敗したので元に戻します"
    cp -p "${HTTP_CONF}.bak-${STAMP}" "$HTTP_CONF"
    cp -p "${SSL_CONF}.bak-${STAMP}"  "$SSL_CONF"
    exit 1
fi

echo "--- 反映確認 ---"
for path in / /stats/ ; do
    printf '%-8s -> ' "$path"
    curl -sS -o /dev/null -w 'HTTP %{http_code}  WWW-Authenticate: %header{www-authenticate}\n' "https://${HOST}${path}"
done
echo "（/stats/ が 401 で Basic realm=... が付いていれば、ログインが効いています）"
