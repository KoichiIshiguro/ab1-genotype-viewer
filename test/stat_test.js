/*
 * stat_test.js - js/stat.js が「送らない条件」を守るかを確認する。
 *
 * ブラウザのAPIを差し替えた箱の中で stat.js を動かし、
 * 画像リクエストとして何が送られたかを見る。
 *   node test/stat_test.js
 */
'use strict';

var fs = require('fs');
var vm = require('vm');
var path = require('path');

var code = fs.readFileSync(path.join(__dirname, '..', 'js', 'stat.js'), 'utf8');

/* 条件を指定して stat.js を1回動かし、送信されたURLの一覧と公開APIを返す */
function run(opts) {
  opts = opts || {};
  var sent = [];

  var ls = {
    _d: {},
    getItem: function (k) { return k in this._d ? this._d[k] : null; },
    setItem: function (k, v) { this._d[k] = String(v); },
    removeItem: function (k) { delete this._d[k]; }
  };
  if (opts.optOut) ls._d.ab1stat = 'off';

  function FakeImage() {
    var o = {};
    Object.defineProperty(o, 'src', { set: function (v) { sent.push(v); } });
    return o;
  }

  var doc = {
    readyState: 'complete',
    getElementById: function () { return null; },
    addEventListener: function () {}
  };

  var ctx = {
    document: doc, Image: FakeImage, Date: Date,
    encodeURIComponent: encodeURIComponent, isFinite: isFinite,
    Math: Math, Object: Object, String: String, console: console
  };
  ctx.window = {
    AB1: undefined,
    location: { protocol: opts.protocol || 'https:', pathname: opts.path || '/' },
    navigator: { doNotTrack: opts.dnt ? '1' : null, globalPrivacyControl: !!opts.gpc },
    localStorage: ls,
    document: doc
  };
  ctx.window.window = ctx.window;

  vm.runInContext('(function(){' + code + '}).call(window)', vm.createContext(ctx));
  return { sent: sent, api: ctx.window.AB1.stat };
}

var ok = 0, ng = 0;
function t(name, cond) {
  if (cond) { ok++; console.log('PASS  ' + name); }
  else { ng++; console.log('FAIL  ' + name); }
}

console.log('--- 送る／送らないの条件 ---');
var a = run({});
t('通常は pv を1件だけ送る', a.sent.length === 1 && /^\/_e\/pv\?t=\d+&p=top$/.test(a.sent[0]));
t('解説ページは p=help', /p=help$/.test(run({ path: '/help.html' }).sent[0]));
t('file:// では送らない', run({ protocol: 'file:' }).sent.length === 0);
t('DNT有効なら送らない', run({ dnt: true }).sent.length === 0);
t('GPC有効なら送らない', run({ gpc: true }).sent.length === 0);
t('オプトアウト済みなら送らない', run({ optOut: true }).sent.length === 0);

console.log('\n--- 送る中身 ---');
var g = run({}); g.sent.length = 0;
g.api.event('analyze', { m: 'target', n: 3, cr: 0.2 });
t('数値と区分だけのクエリになる', /^\/_e\/analyze\?t=\d+&m=target&n=3&cr=0\.2$/.test(g.sent[0]));

var h = run({}); h.sent.length = 0;
h.api.event('ev', { s: 'ATGC[A/G]TTTT 検体名' });
var v = decodeURIComponent(h.sent[0]).match(/s=([^&]*)/)[1];
t('角括弧・スラッシュ・日本語は落とされる', v.indexOf('[') < 0 && v.indexOf('/') < 0 && v.indexOf('検') < 0);

var i = run({}); i.sent.length = 0;
i.api.event('ev', { s: new Array(101).join('A') });
t('値は24文字までに切られる', decodeURIComponent(i.sent[0]).match(/s=([^&]*)/)[1].length === 24);

console.log(ng ? '\n失敗 ' + ng + ' 件' : '\nすべて成功（' + ok + '/' + ok + '）');
process.exit(ng ? 1 : 0);
