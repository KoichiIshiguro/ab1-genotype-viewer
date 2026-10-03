/*
 * stats.js - アクセス統計の閲覧ページ
 *
 * deploy/refresh-stats.sh が書き出した data-{7,30,90}.json を読んで描く。
 * 外部ライブラリは使わない（本体と同じ方針）。グラフはSVGを直接組み立てる。
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var SERIES = ['#2a78d6', '#eb6834', '#1baf7a'];   // 固定順。1=PV/ファイル 2=UU/解析 3=出力
  var current = 30;

  function fmt(n) { return Number(n || 0).toLocaleString('ja-JP'); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function svgEl(tag, attrs) {
    var e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }

  /* ---------------- 読み込み ---------------- */

  function load(days) {
    fetch('data-' + days + '.json', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) { $('notice').style.display = 'none'; render(d); })
      .catch(function (e) {
        var n = $('notice');
        n.style.display = 'block';
        n.textContent = '';
        n.appendChild(document.createTextNode('まだ集計データがありません（' + e.message + '）。サーバーで '));
        n.appendChild(el('code', null, 'bash deploy/refresh-stats.sh --install'));
        n.appendChild(document.createTextNode(' を実行すると10分おきに作られます。vhost 未設置の間はアクセスログ自体がありません。'));
      });
  }

  /* ---------------- 上部の数字 ---------------- */

  function tile(label, value, sub) {
    var t = el('div', 'tile');
    t.appendChild(el('div', 'label', label));
    t.appendChild(el('div', 'value', fmt(value)));
    if (sub) t.appendChild(el('div', 'sub', sub));
    return t;
  }

  function renderTiles(d) {
    var box = $('tiles');
    box.textContent = '';
    var analyzes = (d.events || {}).analyze || 0;
    var exports_ = (d.events || {}).export || 0;
    box.appendChild(tile('ページビュー', d.pageviews, '人のアクセスのみ'));
    box.appendChild(tile('訪問元IP数', d.unique_ips, '期間内のユニーク'));
    box.appendChild(tile('読み込まれたAB1', d.files_loaded, '失敗 ' + fmt(d.files_failed)));
    box.appendChild(tile('解析の実行回数', analyzes, 'のべ ' + fmt(d.analyze_samples) + ' サンプル'));
    box.appendChild(tile('Excel出力', exports_, 'のべ ' + fmt(d.export_rows) + ' 行'));
  }

  /* ---------------- 日別グラフ（グループ棒） ----------------
   * series: [{name, color, byDay:{day:n}}]  days: 連続した日付の配列
   */
  function dayRange(d) {
    var end = new Date();
    end.setHours(0, 0, 0, 0);
    var out = [];
    for (var i = d.days - 1; i >= 0; i--) {
      var t = new Date(end.getTime() - i * 86400000);
      out.push(t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' +
               String(t.getDate()).padStart(2, '0'));
    }
    return out;
  }

  function groupedBars(host, tipEl, days, series) {
    host.querySelectorAll('svg').forEach(function (s) { s.remove(); });
    var W = host.clientWidth || 800, H = host.clientHeight || 220;
    var padL = 36, padR = 8, padT = 8, padB = 22;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H });

    var max = 0;
    series.forEach(function (s) { days.forEach(function (day) { max = Math.max(max, s.byDay[day] || 0); }); });
    // 目盛りが整数で割り切れるよう、4の倍数の切りのよい値に丸める
    var niceMax = 4;
    while (niceMax < max) niceMax = niceMax < 20 ? niceMax + 4 : niceMax < 100 ? niceMax + 20 : Math.ceil(niceMax * 1.5 / 20) * 20;
    var y = function (v) { return padT + plotH - (v / niceMax) * plotH; };

    // 目盛り（控えめに4本）
    for (var g = 0; g <= 4; g++) {
      var v = niceMax * g / 4, yy = y(v);
      svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: yy, y2: yy, 'class': 'grid-line' }));
      var t = svgEl('text', { x: padL - 6, y: yy + 4, 'text-anchor': 'end', 'class': 'axis-text' });
      t.textContent = fmt(Math.round(v));
      svg.appendChild(t);
    }

    var slot = plotW / days.length;
    var gap = 2;                                       // 棒と棒のあいだの地の色
    var barW = Math.max(1, (slot - gap * (series.length + 1)) / series.length);
    var labelEvery = Math.ceil(days.length / Math.max(1, Math.floor(plotW / 56)));

    days.forEach(function (day, i) {
      var x0 = padL + i * slot;
      series.forEach(function (s, k) {
        var v = s.byDay[day] || 0;
        if (v > 0) {
          var h = Math.max(1, y(0) - y(v));
          svg.appendChild(svgEl('rect', {
            x: x0 + gap + k * (barW + gap), y: y(0) - h, width: barW, height: h,
            fill: s.color, rx: Math.min(4, barW / 2), 'class': 'bar'
          }));
          // 角丸は上端だけにしたいので、下端を地の色の矩形で埋める（高さが小さい棒は除く）
          if (h > 4) {
            svg.appendChild(svgEl('rect', { x: x0 + gap + k * (barW + gap), y: y(0) - 4, width: barW, height: 4, fill: s.color }));
          }
        }
      });
      if (i % labelEvery === 0) {
        var lt = svgEl('text', { x: x0 + slot / 2, y: H - 6, 'text-anchor': 'middle', 'class': 'axis-text' });
        lt.textContent = day.slice(5).replace('-', '/');
        svg.appendChild(lt);
      }
      // 当たり判定は棒より大きく（1日ぶんの幅）
      var hit = svgEl('rect', { x: x0, y: padT, width: slot, height: plotH, 'class': 'hit' });
      hit.addEventListener('mousemove', function (ev) { showTip(host, tipEl, ev, day, series); });
      hit.addEventListener('mouseleave', function () { tipEl.style.display = 'none'; });
      svg.appendChild(hit);
    });

    host.appendChild(svg);
  }

  function showTip(host, tipEl, ev, day, series) {
    tipEl.textContent = '';
    tipEl.appendChild(el('b', null, day));
    series.forEach(function (s) {
      var row = el('div', 'row');
      var i = el('i'); i.style.background = s.color;
      row.appendChild(i);
      row.appendChild(el('strong', null, fmt(s.byDay[day] || 0)));
      row.appendChild(el('span', null, s.name));
      tipEl.appendChild(row);
    });
    tipEl.style.display = 'block';
    var r = host.getBoundingClientRect();
    var x = ev.clientX - r.left + 12, yy = ev.clientY - r.top - 10;
    if (x + tipEl.offsetWidth > r.width) x = ev.clientX - r.left - tipEl.offsetWidth - 12;
    tipEl.style.left = x + 'px';
    tipEl.style.top = yy + 'px';
  }

  /* ---------------- 横棒つきの一覧 ---------------- */

  function list(id, obj, opts) {
    opts = opts || {};
    var host = $(id);
    host.textContent = '';
    var items = Object.keys(obj || {}).map(function (k) { return [k, obj[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; });
    if (!items.length) { host.appendChild(el('div', 'empty', '（なし）')); return; }
    var total = items.reduce(function (s, it) { return s + it[1]; }, 0);
    var max = items[0][1];
    var limit = opts.limit || 10;
    var table = el('table', 'list');
    items.slice(0, limit).forEach(function (it) {
      var tr = el('tr');
      var k = el('td', 'k', it[0]); k.title = it[0];
      tr.appendChild(k);
      tr.appendChild(el('td', 'v', fmt(it[1])));
      var b = el('td', 'b');
      var bar = el('span', opts.bad ? 'bad' : null);
      bar.style.width = Math.max(2, it[1] / max * 100) + '%';
      b.appendChild(bar);
      tr.appendChild(b);
      tr.appendChild(el('td', 'p', (it[1] / total * 100).toFixed(1) + '%'));
      table.appendChild(tr);
    });
    host.appendChild(table);
    if (items.length > limit) host.appendChild(el('div', 'more', 'ほか ' + (items.length - limit) + ' 種'));
  }

  /* ---------------- 全体 ---------------- */

  var lastData = null;

  function render(d) {
    lastData = d;
    var range = (d.range && d.range[0]) ? d.range[0].slice(0, 10) + ' 〜 ' + d.range[1].slice(0, 10) : '';
    $('meta').textContent = (range ? '集計範囲 ' + range + '　' : '') +
      '総リクエスト ' + fmt(d.total_requests) + '　更新 ' + (d.generated_at || '').replace('T', ' ').slice(0, 16);

    renderTiles(d);

    var days = dayRange(d);
    groupedBars($('dailyChart'), $('dailyTip'), days, [
      { name: 'ページビュー', color: SERIES[0], byDay: d.pv_by_day || {} },
      { name: '訪問元IP数', color: SERIES[1], byDay: d.uu_by_day || {} }
    ]);

    var ev = d.events_by_day || {};
    var pick = function (name) {
      var o = {};
      Object.keys(ev).forEach(function (day) { o[day] = ev[day][name] || 0; });
      return o;
    };
    var evSeries = [
      { name: 'ファイル読み込み', color: SERIES[0], byDay: pick('files') },
      { name: '解析', color: SERIES[1], byDay: pick('analyze') },
      { name: 'Excel出力', color: SERIES[2], byDay: pick('export') }
    ];
    var lg = $('evLegend');
    lg.textContent = '';
    evSeries.forEach(function (s) {
      var sp = el('span');
      var i = el('i'); i.style.background = s.color;
      sp.appendChild(i); sp.appendChild(document.createTextNode(s.name));
      lg.appendChild(sp);
    });
    groupedBars($('evChart'), $('evTip'), days, evSeries);

    list('pages', d.pages);
    list('referrer', d.referrer);
    list('search_q', d.search_q);
    list('browser', d.browser, { limit: 6 });
    list('os', d.os, { limit: 6 });
    list('events', d.events);
    list('mode', d.mode);
    list('min_call_ratio', d.min_call_ratio, { limit: 6 });
    list('min_intensity', d.min_intensity, { limit: 6 });
    list('min_identity', d.min_identity, { limit: 6 });
    list('bots', d.bots);
    list('bot_pages', d.bot_pages);
    list('errors', d.errors, { bad: true });
  }

  /* ---------------- 期間切替 ---------------- */

  Array.prototype.forEach.call(document.querySelectorAll('.seg button'), function (b) {
    b.addEventListener('click', function () {
      current = Number(b.getAttribute('data-days'));
      Array.prototype.forEach.call(document.querySelectorAll('.seg button'), function (x) {
        x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
      });
      load(current);
    });
  });

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (lastData) render(lastData); }, 150);
  });

  load(current);
}());
