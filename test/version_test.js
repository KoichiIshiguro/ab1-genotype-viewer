/*
 * test/version_test.js - バージョン表記の整合チェック
 *
 * package.json の version と、index.html / help.html の <span class="ver">、
 * 各HTMLの <script src="...?v="> が一致していることを確認する。
 * ?v= はブラウザのキャッシュ更新用（js は max-age=7日でキャッシュされるため、
 * 版を上げずに配信すると古い js が使われ続ける）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const ver = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
let ng = 0;
function check(label, ok) { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) ng++; }

['index.html', 'help.html'].forEach(f => {
  const html = fs.readFileSync(path.join(root, f), 'utf8');
  const m = html.match(/<span class="ver">v([0-9.]+)<\/span>/);
  check(f + ' の表示バージョン = ' + ver, !!m && m[1] === ver);
});
['index.html', 'help.html', 'stats/index.html'].forEach(f => {
  const html = fs.readFileSync(path.join(root, f), 'utf8');
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  const bad = srcs.filter(s => !s.endsWith('?v=' + ver));
  check(f + ' の script ' + srcs.length + ' 件すべてに ?v=' + ver + (bad.length ? '  NG: ' + bad.join(', ') : ''), srcs.length > 0 && bad.length === 0);
});
console.log(ng ? ng + ' 件 FAIL' : 'すべて OK');
process.exit(ng ? 1 : 0);
