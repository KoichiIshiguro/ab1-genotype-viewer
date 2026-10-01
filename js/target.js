/*
 * target.js - ターゲット配列（Primer3風の角括弧記法）のパース
 *
 *   ATCGCCATG[A/G]ATTCCT   候補2種
 *   ATCGCCATG[G]ATTCCT     候補1種
 *
 * MVPは1ターゲットだが、将来の複数ターゲット・19座位一括登録（要件4）に備えて
 * parseAll() は常に配列を返す。
 */
(function (root) {
  'use strict';

  var MIN_FLANK = 8;   // 角括弧の片側に必要な最小塩基数

  function parseOne(rawText, name) {
    var raw = String(rawText || '');
    var text = raw.replace(/\s+/g, '').toUpperCase();

    if (!text) throw new Error('ターゲット配列が入力されていません');

    var open = (text.match(/\[/g) || []).length;
    var close = (text.match(/\]/g) || []).length;
    if (open === 0 || close === 0) {
      throw new Error('角括弧 [ ] で判定対象位置を指定してください（例: ATCGCCATG[A/G]ATTCCT）');
    }
    if (open > 1 || close > 1) {
      throw new Error('角括弧はMVPでは1か所だけ指定できます');
    }

    var m = text.match(/^([^\[\]]*)\[([^\[\]]*)\]([^\[\]]*)$/);
    if (!m) throw new Error('角括弧の記法を解釈できません（例: ATCGCCATG[A/G]ATTCCT）');

    var left = m[1], inside = m[2], right = m[3];

    if (!/^[ACGT]+$/.test(left) || !/^[ACGT]+$/.test(right)) {
      throw new Error('角括弧の前後はA/C/G/Tのみで指定してください');
    }
    if (left.length < MIN_FLANK || right.length < MIN_FLANK) {
      throw new Error('角括弧の前後はそれぞれ' + MIN_FLANK + '塩基以上必要です');
    }

    var alleles = inside.split('/').map(function (s) { return s.trim(); })
                        .filter(function (s) { return s.length > 0; });
    if (!alleles.length) throw new Error('角括弧の中に候補塩基を指定してください');
    alleles.forEach(function (a) {
      if (!/^[ACGT]$/.test(a)) throw new Error('角括弧内は1塩基(A/C/G/T)をスラッシュ区切りで指定してください: ' + a);
    });
    if (alleles.length > 2) throw new Error('角括弧内の候補塩基は2種類までです');

    return {
      name: name || 'Target-1',
      raw: raw.trim(),
      left: left,
      right: right,
      alleles: alleles,
      // アライメント用の配列。判定対象位置は N（ワイルドカード）として扱う
      seq: left + 'N' + right,
      variantIndex: left.length,
      length: left.length + 1 + right.length
    };
  }

  // 1行＝1ターゲット（将来の19座位一括登録用）。空行は無視。
  // 入力が空のときは空配列を返す（= ターゲット未指定。エラーではない）。
  function parseAll(rawText, baseName) {
    var lines = String(rawText || '').split(/[\r\n]+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
    if (!lines.length) return [];
    return lines.map(function (line, i) {
      return parseOne(line, lines.length === 1 ? (baseName || 'Target-1')
                                               : (baseName || 'Target') + '-' + (i + 1));
    });
  }

  var api = { parseOne: parseOne, parseAll: parseAll, MIN_FLANK: MIN_FLANK };

  root.AB1 = root.AB1 || {};
  root.AB1.target = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
