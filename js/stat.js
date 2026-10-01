/*
 * stat.js - 利用統計（ファーストパーティのみ）
 *
 * 送るもの: 操作の種類と件数・設定値（数値）だけ。
 * 送らないもの: AB1ファイルそのもの、塩基配列、ターゲット配列、ファイル名、判定結果、波形。
 *
 * しくみ:
 *   同一オリジンの /_e/<イベント名>?… を画像として読みに行くだけ。
 *   サーバー側は本文を返さず（204）、Apacheのアクセスログに1行残る。
 *   Cookieもローカル保存も使わないので、個人を追跡する仕組みは持たない。
 *
 * 止めるとき:
 *   - ブラウザの「追跡拒否(DNT)」「Global Privacy Control」が有効なら自動で送らない
 *   - localStorage の ab1stat を 'off' にすると送らない（解説ページにスイッチあり）
 *   - file:// で開いたときは送らない（オフライン配布版は通信しない）
 */
(function () {
  'use strict';

  var AB1 = window.AB1 = window.AB1 || {};

  var ENDPOINT = '/_e/';
  var KEY = 'ab1stat';

  function store() {
    try { return window.localStorage; } catch (e) { return null; }   // プライベートモード等
  }

  function optedOut() {
    var s = store();
    return !!(s && s.getItem(KEY) === 'off');
  }

  function doNotTrack() {
    var n = window.navigator;
    return n.doNotTrack === '1' || n.globalPrivacyControl === true || window.doNotTrack === '1';
  }

  function enabled() {
    var p = window.location.protocol;
    if (p !== 'http:' && p !== 'https:') return false;   // file:// 配布版は通信しない
    if (doNotTrack()) return false;
    if (optedOut()) return false;
    return true;
  }

  /* 数値と短い英数字だけを許す。配列やファイル名が紛れ込む事故を防ぐための関門。 */
  function clean(v) {
    if (typeof v === 'number') return isFinite(v) ? String(Math.round(v * 1000) / 1000) : '';
    if (typeof v === 'boolean') return v ? '1' : '0';
    return String(v).replace(/[^0-9A-Za-z_.:-]/g, '').slice(0, 24);
  }

  function event(name, params) {
    if (!enabled()) return;
    var q = ['t=' + Date.now()];
    if (params) {
      Object.keys(params).forEach(function (k) {
        var v = clean(params[k]);
        if (v !== '') q.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
      });
    }
    try {
      new Image().src = ENDPOINT + encodeURIComponent(String(name).slice(0, 24)) + '?' + q.join('&');
    } catch (e) { /* 統計が失敗してもツールの動作には影響させない */ }
  }

  /* 解説ページのオプトアウトスイッチ（あれば配線する） */
  function wireSwitch() {
    var el = document.getElementById('statOptOut');
    if (!el) return;
    var s = store();
    if (!s) { el.disabled = true; return; }
    el.checked = optedOut();
    el.addEventListener('change', function () {
      if (el.checked) s.setItem(KEY, 'off'); else s.removeItem(KEY);
    });
  }

  AB1.stat = { event: event, enabled: enabled };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireSwitch);
  } else {
    wireSwitch();
  }

  // ページ表示。アクセスログだけではボットと人間を分けられないため、JSが動いた証跡として送る。
  event('pv', { p: /help/.test(window.location.pathname) ? 'help' : 'top' });
}());
