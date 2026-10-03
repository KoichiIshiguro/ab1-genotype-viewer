#!/usr/bin/env bash
# アクセス統計の閲覧ページ(/stats/)が読む JSON を作り直す。
# サーバー上で saltybullet として実行する（sudo 不要。adm グループに入っていること）。
#   bash /var/www/ab1-snp.app.saltybullet.com/deploy/refresh-stats.sh            # 1回だけ作る
#   bash /var/www/ab1-snp.app.saltybullet.com/deploy/refresh-stats.sh --install  # 10分おきの cron に登録する
set -euo pipefail

HOST="ab1-snp.app.saltybullet.com"
ROOT="/var/www/${HOST}"
OUT="${ROOT}/stats"
SELF="${ROOT}/deploy/refresh-stats.sh"

if [ "${1:-}" = "--install" ]; then
    LINE="*/10 * * * * /bin/bash ${SELF} >/dev/null 2>&1"
    # crontab が未登録のときは crontab -l が失敗するので、set -e で止まらないよう || true を付ける
    { { crontab -l 2>/dev/null || true; } | { grep -vF "${SELF}" || true; }; echo "${LINE}"; } | crontab -
    echo "cron に登録しました:"
    crontab -l | grep -F "${SELF}"
    exit 0
fi

mkdir -p "${OUT}"
for d in 7 30 90; do
    python3 "${ROOT}/deploy/stats.py" --days "$d" --json --out "${OUT}/data-${d}.json"
done
echo "更新: ${OUT}/data-{7,30,90}.json  $(date '+%Y-%m-%d %H:%M')"
