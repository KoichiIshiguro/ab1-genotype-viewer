#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ab1-snp.app.saltybullet.com のアクセスログ集計。

Apache の combined ログだけを読む。外部サービスもデータベースも使わない。
サーバー上で実行する:
    ssh salty 'python3 /var/www/ab1-snp.app.saltybullet.com/deploy/stats.py'
    ssh salty 'python3 /var/www/ab1-snp.app.saltybullet.com/deploy/stats.py --days 7'
    ssh salty 'python3 /var/www/ab1-snp.app.saltybullet.com/deploy/stats.py --json'

ログが読めない場合は adm グループに入っていない。deploy/setup-vhost.sh を実行すると追加される。
"""
import argparse
import glob
import gzip
import io
import json
import os
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from urllib.parse import unquote, urlsplit, parse_qs

# 動作確認用に AB1_LOG_GLOB で差し替えられるようにしてある
LOG_GLOB = os.environ.get('AB1_LOG_GLOB', '/var/log/apache2/ab1-snp-access.log*')

LINE = re.compile(
    r'^(?P<ip>\S+) \S+ \S+ \[(?P<ts>[^\]]+)\] "(?P<req>[^"]*)" '
    r'(?P<status>\d{3}) (?P<size>\S+) "(?P<ref>[^"]*)" "(?P<ua>[^"]*)"'
)

BOT = re.compile(
    r'bot|crawl|spider|slurp|archiver|monitor|preview|fetcher|scrapy|'
    r'curl|wget|python-requests|libwww|httpclient|okhttp|go-http|headless|'
    r'facebookexternalhit|embedly|quora link preview|pingdom|uptimerobot',
    re.I)

SEARCH = [
    ('Google', re.compile(r'(^|\.)google\.', re.I)),
    ('Bing', re.compile(r'(^|\.)bing\.com$', re.I)),
    ('Yahoo! JAPAN', re.compile(r'(^|\.)(search\.)?yahoo\.co\.jp$', re.I)),
    ('Yahoo', re.compile(r'(^|\.)yahoo\.', re.I)),
    ('DuckDuckGo', re.compile(r'duckduckgo\.com$', re.I)),
    ('Baidu', re.compile(r'baidu\.com$', re.I)),
    ('Yandex', re.compile(r'yandex\.', re.I)),
    ('Ecosia', re.compile(r'ecosia\.org$', re.I)),
    ('Brave', re.compile(r'search\.brave\.com$', re.I)),
    ('Naver', re.compile(r'naver\.com$', re.I)),
]

# 画像・スクリプト等はページビューに数えない
ASSET = re.compile(r'\.(js|css|png|jpg|jpeg|gif|svg|ico|webp|woff2?|map)$', re.I)


def open_log(path):
    if path.endswith('.gz'):
        return io.TextIOWrapper(gzip.open(path, 'rb'), encoding='utf-8', errors='replace')
    return io.open(path, encoding='utf-8', errors='replace')


def parse_time(s):
    # 01/Oct/2026:12:34:56 +0900
    try:
        return datetime.strptime(s, '%d/%b/%Y:%H:%M:%S %z')
    except ValueError:
        return None


def ua_browser(ua):
    u = ua.lower()
    for name, pat in [('Edge', 'edg/'), ('Chrome', 'chrome/'), ('Firefox', 'firefox/'),
                      ('Safari', 'safari/')]:
        if pat in u:
            if name == 'Safari' and ('chrome/' in u or 'edg/' in u):
                continue
            return name
    return 'その他'


def ua_os(ua):
    u = ua.lower()
    for name, pat in [('Windows', 'windows'), ('macOS', 'mac os x'), ('iOS', 'iphone'),
                      ('iPadOS', 'ipad'), ('Android', 'android'), ('Linux', 'linux')]:
        if pat in u:
            return name
    return 'その他'


def bot_name(ua):
    for name, pat in [('Googlebot', 'googlebot'), ('Google-Inspection', 'google-inspectiontool'),
                      ('Bingbot', 'bingbot'), ('Yahoo! Slurp', 'slurp'),
                      ('DuckDuckBot', 'duckduckbot'), ('Applebot', 'applebot'),
                      ('Baiduspider', 'baiduspider'), ('YandexBot', 'yandexbot'),
                      ('GPTBot', 'gptbot'), ('ClaudeBot', 'claudebot'),
                      ('PetalBot', 'petalbot'), ('AhrefsBot', 'ahrefsbot'),
                      ('SemrushBot', 'semrushbot'), ('MJ12bot', 'mj12bot')]:
        if pat in ua.lower():
            return name
    return 'その他のボット'


def search_name(host):
    for name, pat in SEARCH:
        if pat.search(host):
            return name
    return None


def collect(days):
    files = sorted(glob.glob(LOG_GLOB))
    if not files:
        sys.exit('アクセスログが見つかりません: %s（まだ vhost が設置されていない可能性があります）' % LOG_GLOB)

    since = datetime.now(timezone.utc) - timedelta(days=days)
    st = {
        'files': files, 'total': 0, 'skipped': 0,
        'first': None, 'last': None,
        'pv_by_day': defaultdict(int), 'ip_by_day': defaultdict(set),
        'pages': Counter(), 'ips': set(),
        'referrer': Counter(), 'search': Counter(), 'search_q': Counter(),
        'browser': Counter(), 'os': Counter(),
        'bots': Counter(), 'bot_pages': Counter(),
        'events': Counter(), 'ev_day': defaultdict(Counter),
        'files_loaded': 0, 'files_ng': 0, 'analyze_samples': 0,
        'mode': Counter(), 'cr': Counter(), 'mi': Counter(), 'idn': Counter(),
        'export_rows': 0,
        'errors': Counter(),
    }

    for path in files:
        try:
            fh = open_log(path)
        except PermissionError:
            sys.exit('ログを読む権限がありません: %s\n'
                     '  sudo bash %s/setup-vhost.sh を実行して adm グループに入ってください。'
                     % (path, os.path.dirname(os.path.abspath(__file__))))
        with fh:
            for line in fh:
                m = LINE.match(line)
                if not m:
                    st['skipped'] += 1
                    continue
                ts = parse_time(m.group('ts'))
                if ts is None or ts < since:
                    continue
                st['total'] += 1
                if st['first'] is None or ts < st['first']:
                    st['first'] = ts
                if st['last'] is None or ts > st['last']:
                    st['last'] = ts

                day = ts.strftime('%Y-%m-%d')
                req = m.group('req').split(' ')
                path_q = req[1] if len(req) > 1 else '-'
                url = urlsplit(path_q)
                p = unquote(url.path)
                status = int(m.group('status'))
                ua = m.group('ua')
                ref = m.group('ref')
                ip = m.group('ip')

                if status >= 400 and not p.startswith('/_e/'):
                    st['errors'][(status, p[:60])] += 1

                # ---- 利用イベント ----
                if p.startswith('/_e/'):
                    name = p[4:] or '(none)'
                    q = parse_qs(url.query)
                    g = lambda k: (q.get(k) or [''])[0]
                    st['events'][name] += 1
                    st['ev_day'][day][name] += 1
                    if name == 'files':
                        st['files_loaded'] += int(g('ok') or 0)
                        st['files_ng'] += int(g('ng') or 0)
                    elif name == 'analyze':
                        st['analyze_samples'] += int(g('n') or 0)
                        if g('m'):
                            st['mode'][g('m')] += 1
                        for key, dst in (('cr', 'cr'), ('mi', 'mi'), ('id', 'idn')):
                            if g(key):
                                st[dst][g(key)] += 1
                    elif name == 'export':
                        st['export_rows'] += int(g('n') or 0)
                    continue

                # ---- ボット ----
                if BOT.search(ua):
                    st['bots'][bot_name(ua)] += 1
                    if not ASSET.search(p):
                        st['bot_pages'][p] += 1
                    continue

                # ---- 人のアクセス ----
                if ASSET.search(p) or status >= 400:
                    continue
                st['pv_by_day'][day] += 1
                st['ip_by_day'][day].add(ip)
                st['ips'].add(ip)
                st['pages'][p] += 1
                st['browser'][ua_browser(ua)] += 1
                st['os'][ua_os(ua)] += 1

                if not ref or ref == '-':
                    st['referrer']['（直接・ブックマーク等）'] += 1
                else:
                    host = urlsplit(ref).netloc.lower()
                    if host.endswith('ab1-snp.app.saltybullet.com'):
                        st['referrer']['（サイト内）'] += 1
                    else:
                        sn = search_name(host)
                        if sn:
                            st['search'][sn] += 1
                            st['referrer']['検索: ' + sn] += 1
                            qs = parse_qs(urlsplit(ref).query).get('q')
                            if qs:
                                st['search_q'][qs[0]] += 1
                        else:
                            st['referrer'][host or '(不明)'] += 1
    return st


def width(s):
    # 全角文字は2桁ぶんとして数える（表の桁を揃えるため）
    return sum(2 if unicodedata.east_asian_width(c) in 'WF' else 1 for c in s)


def pad(s, n):
    s = str(s)
    while width(s) > n:
        s = s[:-1]
    return s + ' ' * (n - width(s))


def bar(n, mx, width_=28):
    if mx <= 0:
        return ''
    return '█' * max(1, int(round(n / mx * width_))) if n else ''


def table(title, counter, limit=12, total=None):
    print('\n■ %s' % title)
    if not counter:
        print('  （なし）')
        return
    items = counter.most_common(limit)
    mx = items[0][1]
    tot = total if total is not None else sum(counter.values())
    for k, v in items:
        label = k if isinstance(k, str) else ' '.join(str(x) for x in k)
        pct = (' %5.1f%%' % (v / tot * 100)) if tot else ''
        print('  %s %6d%s  %s' % (pad(label, 34), v, pct, bar(v, mx)))
    rest = len(counter) - len(items)
    if rest > 0:
        print('  …ほか %d 種' % rest)


def report(st, days):
    print('=' * 68)
    print('AB1 Genotype Viewer アクセス統計  （直近 %d 日）' % days)
    print('=' * 68)
    print('ログ      : %s' % ', '.join(os.path.basename(f) for f in st['files']))
    if st['first']:
        print('集計範囲  : %s 〜 %s' % (st['first'].strftime('%Y-%m-%d %H:%M'),
                                         st['last'].strftime('%Y-%m-%d %H:%M')))
    print('総リクエスト: %d 行（解析できなかった行 %d）' % (st['total'], st['skipped']))

    pv = sum(st['pv_by_day'].values())
    print('\n■ 人によるページビュー')
    print('  ページビュー %d / 訪問元IP %d 件（ボット・画像・スクリプトを除く）' % (pv, len(st['ips'])))
    if st['pv_by_day']:
        mx = max(st['pv_by_day'].values())
        for day in sorted(st['pv_by_day'])[-21:]:
            print('  %s  PV %4d  UU %4d  %s'
                  % (day, st['pv_by_day'][day], len(st['ip_by_day'][day]),
                     bar(st['pv_by_day'][day], mx)))

    table('ページ別', st['pages'])
    table('流入元', st['referrer'])
    if st['search_q']:
        table('検索キーワード（取得できた分のみ）', st['search_q'])
    table('ブラウザ', st['browser'])
    table('OS', st['os'])

    print('\n' + '-' * 68)
    print('利用状況（ブラウザから送られた操作イベント）')
    print('-' * 68)
    table('イベント別回数', st['events'])
    print('\n  読み込めたAB1ファイル数（延べ）: %d' % st['files_loaded'])
    print('  読み込めなかったファイル数     : %d' % st['files_ng'])
    print('  解析にかけたサンプル数（延べ） : %d' % st['analyze_samples'])
    print('  Excel出力した行数（延べ）      : %d' % st['export_rows'])
    table('解析モード', st['mode'])
    table('最小コール比率の設定値', st['cr'])
    table('最小蛍光強度の設定値', st['mi'])
    table('最小一致率の設定値', st['idn'])

    print('\n' + '-' * 68)
    print('検索エンジンの巡回とエラー')
    print('-' * 68)
    table('ボット別アクセス', st['bots'])
    table('ボットが見たページ', st['bot_pages'])
    table('エラー応答（ステータス・パス）', st['errors'])
    print()


def to_json(st):
    out = {
        'total_requests': st['total'],
        'range': [st['first'].isoformat() if st['first'] else None,
                  st['last'].isoformat() if st['last'] else None],
        'pageviews': sum(st['pv_by_day'].values()),
        'unique_ips': len(st['ips']),
        'pv_by_day': {d: st['pv_by_day'][d] for d in sorted(st['pv_by_day'])},
        'uu_by_day': {d: len(st['ip_by_day'][d]) for d in sorted(st['ip_by_day'])},
        'pages': dict(st['pages']),
        'referrer': dict(st['referrer']),
        'search': dict(st['search']),
        'browser': dict(st['browser']),
        'os': dict(st['os']),
        'bots': dict(st['bots']),
        'events': dict(st['events']),
        'files_loaded': st['files_loaded'],
        'files_failed': st['files_ng'],
        'analyze_samples': st['analyze_samples'],
        'export_rows': st['export_rows'],
        'mode': dict(st['mode']),
        'min_call_ratio': dict(st['cr']),
        'min_intensity': dict(st['mi']),
        'min_identity': dict(st['idn']),
        'errors': {'%d %s' % k: v for k, v in st['errors'].items()},
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))


def main():
    ap = argparse.ArgumentParser(description='AB1 Genotype Viewer のアクセス統計')
    ap.add_argument('--days', type=int, default=30, help='集計する日数（既定30）')
    ap.add_argument('--json', action='store_true', help='JSONで出力する')
    a = ap.parse_args()
    st = collect(a.days)
    if a.json:
        to_json(st)
    else:
        report(st, a.days)


if __name__ == '__main__':
    main()
