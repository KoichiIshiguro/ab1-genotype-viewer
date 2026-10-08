/*
 * app.js - 画面の組み立てと操作
 *
 * レイアウト:
 *   左3列（サンプル・判定・読取方向）は固定、配列部分だけを横スクロールする。
 *   全サンプルを「対象位置からの相対位置」という共通の軸に載せる。
 *   各サンプルの対象位置（anchor）を列0に置くので、縦に見れば対象位置が1列に揃う。
 *   塩基番号はサンプルごとに自分のリード内の番号を表示する。
 *   ターゲットは FASTA で複数入れられ、サンプルごとにプルダウンで選ぶ（既定は先頭）。
 *   波形はスクロール領域に重ねた1枚のcanvasに、表示範囲だけ描く。
 */
(function () {
  'use strict';

  var AB1 = window.AB1;
  var $ = function (id) { return document.getElementById(id); };

  // 利用統計。stat.js を外した配布でも動くように存在チェックしてから呼ぶ。
  function stat(name, params) {
    if (AB1.stat) AB1.stat.event(name, params);
  }

  var COLW = 33;        // 1塩基あたりの幅(px) — CSS の --colw と一致させる
  var TRACE_TOP = 48;   // 行内の波形描画開始位置（塩基26px＋塩基番号の行の下）
  var TRACE_H = 50;

  var CHANNEL_COLORS = { A: '#33a36b', T: '#d84c55', G: '#343944', C: '#3578dc' };

  var samples = [];     // { fileName, read } または { fileName, error }
  var results = [];
  var targets = [];     // 入力欄から読んだターゲット（FASTAなら複数）
  var assign = {};      // fileName → targets のインデックス。未設定は 0（先頭）
  var centerPending = false;   // 解析し直した直後に対象位置を画面中央へスクロールする
  var axis = { gMin: 0, gMax: 0, cols: 0 };
  var selected = { sample: -1, coord: null };
  var rafPending = false;

  /* ---------------- 設定値 ---------------- */

  function settings() {
    return {
      minIntensity: Number($('minIntensity').value),
      minCallRatio: Number($('minCallRatio').value),
      minIdentity: Number($('minIdentity').value)
    };
  }

  /* ---------------- 警告表示 ---------------- */

  function showWarnings(list) {
    var box = $('warnbox');
    box.innerHTML = '';
    if (!list.length) { box.style.display = 'none'; return; }
    box.style.display = 'flex';
    list.forEach(function (w) {
      var d = document.createElement('div');
      d.className = 'warn' + (w.type === 'err' ? ' err' : '');
      d.textContent = w.msg;
      box.appendChild(d);
    });
  }

  /* ---------------- ファイル読込 ---------------- */

  function readArrayBuffer(file) {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('ファイルを読み取れません')); };
      fr.readAsArrayBuffer(file);
    });
  }

  function addFiles(fileList) {
    var list = Array.prototype.slice.call(fileList), warnings = [];
    var chain = Promise.resolve();

    list.forEach(function (f) {
      chain = chain.then(function () {
        if (!/\.(ab1|abi)$/i.test(f.name)) {
          warnings.push({ type: 'err', msg: f.name + '：AB1／ABIファイルではありません' });
          return;
        }
        if (samples.some(function (s) { return s.fileName === f.name; })) {
          warnings.push({ type: 'warn', msg: f.name + '：同じファイルを既に読み込んでいます（重複のため追加しません）' });
          return;
        }
        return readArrayBuffer(f).then(function (buf) {
          var read;
          try {
            read = AB1.abif.parse(buf);
          } catch (e) {
            samples.push({ fileName: f.name, error: e.message });
            warnings.push({ type: 'err', msg: f.name + '：読み込めません（' + e.message + '）' });
            return;
          }
          if (read.sampleName) {
            var dup = samples.filter(function (s) {
              return s.read && s.read.sampleName === read.sampleName;
            })[0];
            if (dup) {
              warnings.push({ type: 'warn', msg: f.name + '：AB1内のサンプル名「' + read.sampleName +
                                                '」が ' + dup.fileName + ' と重複しています' });
            }
          }
          if (read.callableBases === 0) {
            warnings.push({ type: 'warn', msg: f.name + '：ベースコールされた塩基がありません（シーケンス失敗）' });
          }
          samples.push({ fileName: f.name, read: read });
        });
      });
    });

    chain.then(function () {
      stat('files', {
        n: list.length,
        ok: samples.filter(function (s) { return s.read; }).length,
        ng: samples.filter(function (s) { return s.error; }).length
      });
      analyze(warnings);
    });
  }

  /* ---------------- 解析 ---------------- */

  function analyze(extraWarnings) {
    var warnings = (extraWarnings || []).slice();

    try {
      targets = AB1.target.parseAll($('target').value, $('targetName').value.trim() || 'Target-1');
    } catch (e) {
      targets = [];
      warnings.push({ type: 'err', msg: 'ターゲット配列：' + e.message });
    }

    var cfg = settings();
    results = samples.map(function (s) { return AB1.call.analyze(s, targetFor(s.fileName), cfg); });

    // 列の座標 = サンプル内インデックス − anchor。対象位置が列0。
    var shown = results.filter(function (r) { return r.displayable; });
    if (shown.length) {
      axis.gMin = Math.min.apply(null, shown.map(function (r) { return -r.anchor; }));
      axis.gMax = Math.max.apply(null, shown.map(function (r) { return r.oriented.seq.length - 1 - r.anchor; }));
    } else {
      axis.gMin = 0;
      axis.gMax = targets.length ? targets[0].length - 1 : 0;
    }
    axis.cols = axis.gMax - axis.gMin + 1;
    centerPending = targets.length > 0;

    if (selected.sample >= results.length) selected = { sample: -1, coord: null };
    if (selected.sample < 0 && results.length) {
      var firstOk = results.findIndex(function (r) { return r.displayable; });
      selected = { sample: firstOk >= 0 ? firstOk : 0, coord: defaultCoord(results[firstOk >= 0 ? firstOk : 0]) };
    }

    // サンプルが無い状態の自動実行（ページ初期化・設定変更）は数えない
    if (results.length) stat('analyze', {
      m: targets.length ? 'target' : 'scan',   // ターゲット指定あり／全塩基スキャン
      t: targets.length,                       // FASTAで入れたターゲット数
      n: results.length,
      ok: shown.length,
      w: warnings.length,
      cr: cfg.minCallRatio,                    // 実際に使われているしきい値の分布を見るため
      mi: cfg.minIntensity,
      id: cfg.minIdentity
    });

    showWarnings(warnings);
    render();
  }

  /* サンプルに割り当てたターゲット。未設定・範囲外は先頭（既定）。ターゲットが無ければ null */
  function targetFor(fileName) {
    if (!targets.length) return null;
    var i = assign[fileName];
    return targets[(i != null && i >= 0 && i < targets.length) ? i : 0];
  }

  /* ---------------- 描画 ---------------- */

  function defaultCoord(r) {
    if (!r || !r.displayable) return null;
    if (r.mode === 'scan') return r.hetSites && r.hetSites.length ? r.hetSites[0].index : null;
    return 0;   // 対象位置は常に列0
  }

  function badgeText(r) {
    if (r.mode !== 'scan') return r.genotype;
    if (r.status !== 'scan') return r.zygosity;
    return r.hetSites.length ? 'ヘテロ ' + r.hetSites.length + '箇所' : 'ホモのみ';
  }

  function badgeSub(r) {
    if (r.mode !== 'scan') return r.zygosity;
    if (r.status !== 'scan') return r.message ? '' : r.zygosity;
    return '判定対象 ' + r.evaluated + ' 塩基';
  }

  function badgeClass(r) {
    if (r.status === 'scan') return r.hetSites.length ? '' : 'homo';
    if (r.status === 'no_evaluable') return 'n';
    if (r.status === 'ok') return r.zygosity === 'ホモ' ? 'homo' : '';
    if (r.status === 'low_signal' || r.status === 'no_candidate' || r.status === 'ambiguous') return 'n';
    return 'fail';
  }

  function render() {
    $('count').textContent = results.length
      ? results.length + ' samples · ' +
        (targets.length
          ? (targets.length > 1 ? 'ターゲット ' + targets.length + ' 件 · ' : '') + '対象位置を中央に揃えて表示'
          : 'ターゲット未指定（各ファイルをそのまま表示）')
      : '0 samples';
    $('empty').style.display = results.length ? 'none' : 'block';
    $('board').style.display = results.length ? 'flex' : 'none';
    $('footnote').textContent = targets.length
      ? (targets.length > 1
          ? '各サンプルのプルダウンでターゲットを選べます（既定は先頭の ' + targets[0].name + '）'
          : '対象位置: ' + targets[0].name + ' の ' + (targets[0].variantIndex + 1) + ' 塩基目 [' +
            targets[0].alleles.join('/') + ']') +
        '　·　塩基番号は各サンプル内の番号　·　塩基をクリックまたはポイントすると詳細値を表示します'
      : 'ターゲット未指定：各ファイルの全塩基でホモ／ヘテロを判定しています　·　塩基をクリックまたはポイントすると詳細値を表示します';

    renderFixedColumn();
    renderTracks();
    if (centerPending) { centerPending = false; scrollToCoord(0); }
    drawTraces();
    renderDetails();
  }

  function renderFixedColumn() {
    var col = $('fixedCol');
    col.innerHTML = '';

    var head = document.createElement('div');
    head.className = 'hrow';
    head.innerHTML = '<div>サンプル</div><div>判定</div><div>読取方向</div>';
    col.appendChild(head);

    results.forEach(function (r, i) {
      var row = document.createElement('div');
      row.className = 'srow' + (selected.sample === i ? ' sel' : '');
      row.innerHTML =
        '<div class="cell sample"><strong></strong><small></small></div>' +
        '<div class="cell call"><span class="badge ' + badgeClass(r) + '"></span><small></small></div>' +
        '<div class="cell direction"><span></span><small></small></div>';
      row.querySelector('.sample strong').textContent = r.label;
      row.querySelector('.sample small').textContent =
        r.sampleName ? 'AB1サンプル名: ' + r.sampleName : r.fileName;
      if (targets.length > 1 && !r.error) {
        // ターゲットが複数あるときだけ、サンプルごとの選択肢を出す
        var sel = document.createElement('select');
        sel.className = 'tsel';
        sel.title = 'このサンプルに使うターゲット';
        targets.forEach(function (t, ti) {
          var o = document.createElement('option');
          o.value = String(ti);
          o.textContent = t.name;
          sel.appendChild(o);
        });
        sel.value = String(targets.indexOf(r.target) >= 0 ? targets.indexOf(r.target) : 0);
        sel.onclick = function (ev) { ev.stopPropagation(); };
        sel.onchange = function (ev) {
          ev.stopPropagation();
          assign[r.fileName] = Number(sel.value);
          stat('retarget', { t: targets.length });
          analyze([]);
        };
        row.querySelector('.sample').appendChild(sel);
      }
      row.querySelector('.badge').textContent = badgeText(r);
      row.querySelector('.call small').textContent = badgeSub(r);
      row.querySelector('.direction span').textContent = r.direction;
      row.querySelector('.direction small').textContent = r.directionNote;
      row.onclick = function () {
        selected = { sample: i, coord: defaultCoord(r) };
        render();
      };
      col.appendChild(row);
    });
  }

  function renderTracks() {
    var ruler = $('ruler'), tracks = $('tracks');
    var width = axis.cols * COLW;

    ruler.innerHTML = '';
    ruler.style.width = width + 'px';
    var hasTarget = targets.length > 0;
    for (var c = axis.gMin; c <= axis.gMax; c++) {
      var isVariant = hasTarget && c === 0;
      var label = null;
      if (isVariant) {
        label = '▼ 対象位置';
      } else if (hasTarget) {
        if (c % 10 === 0) label = (c > 0 ? '+' : '') + c;   // 対象位置からの相対位置
      } else if (c >= 0 && (c + 1) % 10 === 0) {
        label = String(c + 1);   // ターゲット未指定時はサンプル内の塩基番号
      }
      if (label === null) continue;
      var tick = document.createElement('div');
      tick.className = 'tick' + (isVariant ? ' variant' : '');
      tick.style.left = ((c - axis.gMin) * COLW) + 'px';
      tick.textContent = label;
      ruler.appendChild(tick);
    }

    tracks.innerHTML = '';
    results.forEach(function (r, i) {
      var track = document.createElement('div');
      track.className = 'track' + (r.displayable ? '' : ' unaligned') + (selected.sample === i ? ' sel' : '');
      track.style.width = width + 'px';
      track.dataset.sample = String(i);

      if (!r.displayable) {
        var note = document.createElement('div');
        note.className = 'note';
        note.textContent = r.message;
        track.appendChild(note);
      } else {
        var bases = document.createElement('div');
        bases.className = 'bases';
        var startCoord = -r.anchor;
        var pad = '<span style="display:inline-block;width:' + ((startCoord - axis.gMin) * COLW) + 'px"></span>';
        var html = pad, posHtml = pad;
        var seq = r.oriented.seq;
        var t = r.target;
        var tFrom = t ? -t.variantIndex : null, tTo = t ? t.length - 1 - t.variantIndex : null;
        var hetAt = {};
        (r.hetSites || []).forEach(function (h) { hetAt[h.index] = true; });
        for (var s = 0; s < seq.length; s++) {
          var coord = s - r.anchor;
          var cls = 'base';
          if (t && coord >= tFrom && coord <= tTo) cls += ' in-target';
          if (t && coord === 0) cls += ' target-base';
          if (hetAt[s]) cls += ' het-base';
          var ch = seq.charAt(s);
          html += '<span class="' + cls + '" data-s="' + s + '" data-coord="' + coord +
                  '" style="color:' + (CHANNEL_COLORS[ch] || '#8b93a4') + '">' + ch + '</span>';
          // サンプルごとの塩基番号（10塩基ごと＋対象位置）
          var isAnchor = t && coord === 0;
          posHtml += '<span class="pos' + (isAnchor ? ' anchor' : '') + '">' +
                     ((s + 1) % 10 === 0 || isAnchor ? (s + 1) : '') + '</span>';
        }
        bases.innerHTML = html;
        track.appendChild(bases);
        if (t) {
          var posLine = document.createElement('div');
          posLine.className = 'posline';
          posLine.innerHTML = posHtml;
          track.appendChild(posLine);
        }
      }

      track.onclick = function (ev) {
        var el = ev.target.closest ? ev.target.closest('.base') : null;
        selected = { sample: i, coord: el ? Number(el.dataset.coord) : defaultCoord(r) };
        render();
      };
      tracks.appendChild(track);
    });
  }

  function scheduleDraw() {
    if (rafPending) return;
    rafPending = true;
    window.requestAnimationFrame(function () { rafPending = false; drawTraces(); });
  }

  function drawTraces() {
    var wrap = $('scrollWrap'), canvas = $('traceLayer');
    if (!results.length) return;
    var dpr = window.devicePixelRatio || 1;
    var w = wrap.clientWidth, h = wrap.clientHeight;
    if (w <= 0 || h <= 0) return;

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';

    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var scrollLeft = $('scroller').scrollLeft;

    // 行の縦位置はCSSの値から計算せず、実際の .track 要素の位置を測って使う。
    // （定数で持つと1pxの差が行ごとに積み上がり、下の行ほど波形がずれる）
    var wrapTop = wrap.getBoundingClientRect().top;
    var trackEls = $('tracks').children;

    results.forEach(function (r, i) {
      if (!r.displayable) return;
      var el = trackEls[i];
      if (!el) return;
      var top = el.getBoundingClientRect().top - wrapTop;
      if (top > h || top + TRACE_TOP + TRACE_H < 0) return;   // 画面外は描かない
      drawRow(ctx, r, top, scrollLeft, w);
    });
  }

  function drawRow(ctx, r, top, scrollLeft, viewW) {
    var read = r.oriented, S = read.seq.length;
    var bottom = top + TRACE_TOP + TRACE_H;

    // 画面に入っているサンプル内インデックスの範囲
    var firstCoord = Math.floor(scrollLeft / COLW) + axis.gMin - 1;
    var lastCoord = firstCoord + Math.ceil(viewW / COLW) + 2;
    var sFrom = Math.max(0, firstCoord + r.anchor);
    var sTo = Math.min(S - 1, lastCoord + r.anchor);
    if (sTo <= sFrom) return;

    var xOf = function (s) { return (s - r.anchor - axis.gMin) * COLW + COLW / 2 - scrollLeft; };
    var scale = r.scaleRef || 1000;

    ['A', 'T', 'G', 'C'].forEach(function (base) {
      var trace = read.traces[base];
      ctx.beginPath();
      var started = false;
      for (var s = sFrom; s < sTo; s++) {
        var p0 = read.ploc[s], p1 = read.ploc[s + 1];
        if (p1 <= p0) continue;
        var x0 = xOf(s), span = p1 - p0;
        for (var k = p0; k < p1; k++) {
          var v = trace[k];
          if (!(v > 0)) v = 0;
          var y = bottom - Math.min(1, v / scale) * TRACE_H;
          var x = x0 + ((k - p0) / span) * COLW;
          if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
        }
      }
      if (!started) return;
      ctx.strokeStyle = CHANNEL_COLORS[base];
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    });
  }

  /* ---------------- 詳細表示 ---------------- */

  function renderDetails() {
    var r = results[selected.sample];
    var bars = $('bars'), kv = $('detailKv'), hetlist = $('hetlist');

    if (!r) {
      $('selectedName').textContent = '—';
      bars.innerHTML = '';
      kv.innerHTML = '';
      hetlist.innerHTML = '';
      $('bigcall').textContent = '—';
      $('type').textContent = '—';
      $('type').className = 'badge';
      $('callmeta').textContent = 'AB1ファイルを読み込んでください';
      $('notice').textContent = '—';
      $('notice').className = 'notice';
      $('flags').innerHTML = '';
      return;
    }

    $('selectedName').textContent = r.label;

    var site = null, positionLabel = '';
    if (r.displayable && selected.coord != null) {
      site = AB1.call.measure(r.oriented, selected.coord + r.anchor);
    } else if (r.mode !== 'scan') {
      site = r.site;
    }
    if (site) {
      if (r.mode === 'scan') {
        positionLabel = (site.index + 1) + ' 塩基目' +
          (isHetSite(r, site.index) ? '（ヘテロと判定した位置）' : '');
      } else if (selected.coord === 0) {
        positionLabel = '対象位置（' + r.targetName + ' の ' + (r.target.variantIndex + 1) + ' 塩基目）';
      } else {
        positionLabel = '対象位置から ' + (selected.coord > 0 ? '+' : '') + selected.coord + ' 塩基';
      }
    }

    if (site) {
      bars.innerHTML = AB1.call.BASES.map(function (b) {
        return '<div class="bar"><span>' + b + '</span>' +
               '<strong style="color:' + CHANNEL_COLORS[b] + '">' +
               Math.round(site.ratios[b] * 100) + '%</strong>' +
               '<em>' + site.intensities[b] + '</em>' +
               '<div class="bar-line"><i style="width:' + (site.ratios[b] * 100) +
               '%;background:' + CHANNEL_COLORS[b] + '"></i></div></div>';
      }).join('');
      kv.innerHTML =
        row('サンプル名', r.sampleName || r.label) +
        row('元ファイル名', r.fileName) +
        (r.mode === 'scan' ? '' : row('ターゲット', r.targetName)) +
        row('表示位置', positionLabel) +
        row('サンプル内位置', (site.index + 1) + ' / ' + r.oriented.seq.length + ' 塩基目') +
        row('ベースコール', site.base) +
        row('合計蛍光強度', String(site.total)) +
        row('Quality score', site.quality != null ? String(site.quality) : '—') +
        row('元の読取方向', r.mode === 'scan' ? '—（ターゲット未指定のため判定なし）'
          : r.direction + (r.directionNote ? '（' + r.directionNote + '）' : '')) +
        row('アライメント状態', r.mode === 'scan' ? 'ターゲット未指定（照合なし）'
          : (r.aligned
            ? '一致率 ' + (r.alignment.identity * 100).toFixed(1) + '%（' +
              r.alignment.matches + '/' + r.alignment.compared + '塩基一致）'
            : 'アライメント不可'));
    } else {
      bars.innerHTML = '';
      kv.innerHTML = row('元ファイル名', r.fileName) + row('状態', r.message) +
        (r.mode === 'scan' && r.displayable ? row('操作', '配列上の塩基をクリックすると比率を表示します') : '');
    }

    $('bigcall').textContent = badgeText(r);
    var type = $('type');
    type.textContent = (r.mode === 'scan' ? r.zygosity : r.zygosity) || '—';
    type.className = 'badge ' + badgeClass(r);

    if (r.mode === 'scan') {
      $('callmeta').textContent = r.status === 'scan'
        ? 'ターゲット未指定・全塩基スキャン（判定対象 ' + r.evaluated + ' 塩基 / 全 ' +
          r.oriented.seq.length + ' 塩基）'
        : '判定対象となる位置がありません';
    } else {
      $('callmeta').textContent = r.aligned && r.site
        ? '対象位置 ' + (r.site.index + 1) + ' 塩基目 · Quality ' +
          (r.site.quality != null ? r.site.quality : '—') + ' · 元の読取方向 ' + r.direction +
          ' → ターゲット方向に統一'
        : (r.aligned ? '対象位置を判読できません' : '対象位置・方向を特定できません');
    }

    var notice = $('notice');
    notice.textContent = r.message;
    notice.className = 'notice' + ((r.status === 'ok' || (r.status === 'scan' && !r.hetSites.length)) ? '' :
      (r.status === 'low_signal' || r.status === 'ambiguous' || r.status === 'no_candidate' ||
       r.status === 'no_evaluable' || r.status === 'scan' ? ' warnstate' : ' failstate'));

    $('flags').innerHTML = (r.flags || []).map(function (f) {
      return '<li>' + escapeHtml(f) + '</li>';
    }).join('');

    renderHetList(r);
  }

  function isHetSite(r, index) {
    return (r.hetSites || []).some(function (h) { return h.index === index; });
  }

  /** ターゲット未指定時に、ヘテロと判定した位置へ飛べるボタンを並べる */
  function renderHetList(r) {
    var hetlist = $('hetlist');
    hetlist.innerHTML = '';
    if (r.mode !== 'scan' || r.status !== 'scan') return;
    if (!r.hetSites.length) {
      hetlist.innerHTML = '<span class="none">ヘテロと判定した位置はありません</span>';
      return;
    }
    var MAX_BUTTONS = 60;
    r.hetSites.slice(0, MAX_BUTTONS).forEach(function (h) {
      var b = document.createElement('button');
      b.textContent = (h.index + 1) + '　' + h.genotype;
      b.onclick = function () {
        selected = { sample: selected.sample, coord: h.index - r.anchor };
        render();
        scrollToCoord(h.index - r.anchor);
      };
      hetlist.appendChild(b);
    });
    if (r.hetSites.length > MAX_BUTTONS) {
      var more = document.createElement('span');
      more.className = 'none';
      more.textContent = '他 ' + (r.hetSites.length - MAX_BUTTONS) +
                         ' 箇所（全件はExcel出力で確認できます）';
      hetlist.appendChild(more);
    }
  }

  function scrollToCoord(coord) {
    var scroller = $('scroller');
    scroller.scrollLeft = (coord - axis.gMin) * COLW - scroller.clientWidth / 2;
    scheduleDraw();
  }

  function row(k, v) {
    return '<b>' + escapeHtml(k) + '</b><span>' + escapeHtml(v) + '</span>';
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ---------------- ホバー ---------------- */

  function onHover(ev) {
    var el = ev.target.closest ? ev.target.closest('.base') : null;
    var hint = $('hint');
    if (!el) { hint.style.display = 'none'; return; }
    var track = el.closest('.track');
    var r = results[Number(track.dataset.sample)];
    var site = AB1.call.measure(r.oriented, Number(el.dataset.s));
    if (!site) { hint.style.display = 'none'; return; }

    var lines = [
      r.label,
      r.mode === 'scan'
        ? 'サンプル内 ' + (site.index + 1) + ' 塩基目' + (isHetSite(r, site.index) ? '（ヘテロ）' : '')
        : (Number(el.dataset.coord) === 0 ? '対象位置'
            : '対象位置から ' + (Number(el.dataset.coord) > 0 ? '+' : '') + el.dataset.coord) +
          ' / サンプル内 ' + (site.index + 1) + ' 塩基目（' + r.targetName + '）',
      'ベースコール ' + site.base + '　Quality ' + (site.quality != null ? site.quality : '—'),
      '合計強度 ' + site.total
    ].concat(AB1.call.BASES.map(function (b) {
      return b + '  ' + (site.ratios[b] * 100).toFixed(1).padStart(5) + '%  (' + site.intensities[b] + ')';
    }));

    hint.textContent = lines.join('\n');
    hint.style.display = 'block';
    var pad = 14;
    var x = ev.clientX + pad, y = ev.clientY + pad;
    var rect = hint.getBoundingClientRect();
    if (x + rect.width > window.innerWidth) x = ev.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight) y = ev.clientY - rect.height - pad;
    hint.style.left = x + 'px';
    hint.style.top = y + 'px';
  }

  /* ---------------- Excel出力 ---------------- */

  function exportXlsx() {
    if (!results.length) { alert('出力するサンプルがありません'); return; }
    var bytes = AB1.export.buildWorkbook(results, 'Genotype');
    var blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    var d = new Date();
    var stamp = d.getFullYear() +
      String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    var name = 'AB1_genotype_' + (target ? target.name : 'target') + '_' + stamp + '.xlsx';
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    stat('export', { n: results.length });
  }

  /* ---------------- イベント ---------------- */

  var drop = $('drop'), fileInput = $('files');
  drop.onclick = function () { fileInput.click(); };
  fileInput.onchange = function (e) { addFiles(e.target.files); fileInput.value = ''; };

  ['dragenter', 'dragover'].forEach(function (type) {
    drop.addEventListener(type, function (e) { e.preventDefault(); drop.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach(function (type) {
    drop.addEventListener(type, function (e) { e.preventDefault(); drop.classList.remove('drag'); });
  });
  drop.addEventListener('drop', function (e) { addFiles(e.dataTransfer.files); });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  $('analyze').onclick = function () { analyze([]); };
  ['minIntensity', 'minCallRatio', 'minIdentity', 'targetName'].forEach(function (id) {
    $(id).addEventListener('change', function () { analyze([]); });
  });

  $('scroller').addEventListener('scroll', scheduleDraw);
  window.addEventListener('resize', scheduleDraw);
  $('tracks').addEventListener('mousemove', onHover);
  $('tracks').addEventListener('mouseleave', function () { $('hint').style.display = 'none'; });
  $('export').onclick = exportXlsx;


  /* ---------------- 動作確認用のプリロード ----------------
   * index.html?preload=a.ab1,b.ab1 で同じ階層のファイルを読み込む。
   * （file:// では fetch が使えないため、ローカルHTTPサーバー経由のときだけ機能する）
   */
  (function () {
    var m = /[?&]preload=([^&]+)/.exec(window.location.search);
    if (!m) return;
    var names = decodeURIComponent(m[1]).split(',').filter(function (n) { return !!n; });
    Promise.all(names.map(function (n) {
      return fetch(n).then(function (res) { return res.arrayBuffer(); })
        .then(function (buf) { return { name: n, buffer: buf }; });
    })).then(function (items) { window.ab1app.addBuffers(items); })
      .catch(function (e) { console.error('preload failed', e); });
  })();

  analyze([]);   // 起動時にターゲット配列を検証して対象位置を表示しておく

  window.ab1app = {
    addBuffers: function (items) {   // 自動テスト用: [{name, buffer}]
      items.forEach(function (it) {
        try {
          samples.push({ fileName: it.name, read: AB1.abif.parse(it.buffer) });
        } catch (e) {
          samples.push({ fileName: it.name, error: e.message });
        }
      });
      analyze([]);
    },
    getResults: function () { return results; }
  };
})();
