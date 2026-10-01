/*
 * export.js - 解析結果 → Excel出力用の行データ（要件12）
 *
 * 比率は小数（0〜1、小数第4位）で統一する。
 * 「位置」列は要件の列一覧にはないが、要件12が「少なくとも次の列」としているため追加している。
 *   - ターゲット指定あり: 対象位置のサンプル内位置
 *   - ターゲット未指定  : ヘテロと判定した位置
 *
 * 行の作り方:
 *   - ターゲット指定あり: 1サンプル1行
 *   - ターゲット未指定  : ヘテロ位置1つにつき1行（0箇所のサンプルは要約1行）
 */
(function (root) {
  'use strict';

  var COLUMNS = [
    'サンプル名', '元ファイル名', 'ターゲット名', '判定', '遺伝型', '実測対象塩基', '位置',
    'A比率', 'T比率', 'G比率', 'C比率',
    'A蛍光強度', 'T蛍光強度', 'G蛍光強度', 'C蛍光強度',
    'Quality score', '元の読取方向', 'アライメント可否', 'コメント'
  ];

  var WIDTHS = [26, 34, 18, 14, 10, 12, 8, 9, 9, 9, 9, 12, 12, 12, 12, 13, 16, 18, 60];

  function round4(v) { return Math.round(v * 10000) / 10000; }

  function alignmentLabel(r) {
    if (r.mode === 'scan') return '—（ターゲット未指定）';
    if (r.status === 'load_error' || r.status === 'no_basecall') return '—';
    if (r.status === 'unaligned') return '不可';
    return '可';
  }

  function ratioComment(site, minCallRatio) {
    return root.AB1.call.BASES.filter(function (b) { return site.ratios[b] >= minCallRatio; })
      .map(function (b) { return b + ' ' + Math.round(site.ratios[b] * 100) + '%'; })
      .join('・');
  }

  function makeRow(r, site, judgement, genotype, comment) {
    var ratios = site ? site.ratios : null, ints = site ? site.intensities : null;
    return [
      r.sampleName || r.label,
      r.fileName,
      r.mode === 'scan' ? '（ターゲット未指定）' : r.targetName,
      judgement,
      genotype,
      site ? site.base : '',
      site ? site.index + 1 : null,
      ratios ? round4(ratios.A) : null,
      ratios ? round4(ratios.T) : null,
      ratios ? round4(ratios.G) : null,
      ratios ? round4(ratios.C) : null,
      ints ? ints.A : null,
      ints ? ints.T : null,
      ints ? ints.G : null,
      ints ? ints.C : null,
      site && site.quality != null ? site.quality : null,
      r.direction || '—',
      alignmentLabel(r),
      comment
    ];
  }

  function joinComment() {
    return Array.prototype.slice.call(arguments)
      .reduce(function (acc, v) { return acc.concat(v || []); }, [])
      .filter(function (s) { return !!s; }).join(' / ');
  }

  /** 1サンプル分の行（ターゲット未指定時は複数行になる） */
  function rowsForResult(r) {
    if (r.mode === 'scan' && r.hetSites && r.hetSites.length) {
      return r.hetSites.map(function (h) {
        return makeRow(r, h.site, 'ヘテロ', h.genotype,
          joinComment(ratioComment(h.site, r.settings.minCallRatio) +
            ' が最小コール比率 ' + Math.round(r.settings.minCallRatio * 100) + '% 以上', r.flags));
      });
    }
    return [makeRow(r, r.mode === 'scan' ? null : r.site, r.zygosity || '', r.genotype,
      joinComment(r.message, r.flags))];
  }

  function toRows(results) {
    return [COLUMNS].concat(results.reduce(function (acc, r) {
      return acc.concat(rowsForResult(r));
    }, []));
  }

  function buildWorkbook(results, sheetName) {
    return root.AB1.xlsx.build(toRows(results), {
      sheetName: sheetName || 'Genotype',
      colWidths: WIDTHS
    });
  }

  var api = {
    COLUMNS: COLUMNS, WIDTHS: WIDTHS,
    rowsForResult: rowsForResult, toRows: toRows, buildWorkbook: buildWorkbook
  };

  root.AB1 = root.AB1 || {};
  root.AB1.export = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
