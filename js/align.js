/*
 * align.js - ターゲット配列と各リードの照合（順方向／逆相補の自動判定）
 *
 * ギャップなしのスライド照合。Sangerの読み始め・読み終わりは N が連続するため、
 * N は加点も減点もしない（= 比較対象から外す）。
 *
 * 座標系の定義:
 *   target[t] と sample[offset + t] が対応する。
 *   「ターゲット座標 t」= サンプル内インデックス - offset。全サンプルで共通の軸になる。
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    minOverlap: 30,     // 比較に使えた塩基数の下限
    minIdentity: 0.80   // 一致率の下限（要件6: 採用基準）
  };

  function scoreAt(seq, targetSeq, offset) {
    var T = targetSeq.length, S = seq.length;
    var matches = 0, mismatches = 0, t, s, tb, sb;
    for (t = 0; t < T; t++) {
      s = offset + t;
      if (s < 0 || s >= S) continue;
      tb = targetSeq.charAt(t);
      if (tb === 'N') continue;            // 判定対象位置はワイルドカード
      sb = seq.charAt(s);
      if (sb === 'N' || sb === '-') continue;  // 読めていない位置は中立
      if (sb === tb) matches++; else mismatches++;
    }
    return { matches: matches, mismatches: mismatches };
  }

  /** 1つの向きについて最良のオフセットを探す */
  function bestOffset(seq, targetSeq, opts) {
    var T = targetSeq.length, S = seq.length;
    var minOv = Math.min(opts.minOverlap, T);
    var from = -(T - minOv), to = S - minOv;
    var best = null, offset, r, compared, identity, score;

    for (offset = from; offset <= to; offset++) {
      r = scoreAt(seq, targetSeq, offset);
      compared = r.matches + r.mismatches;
      if (compared < minOv) continue;
      score = r.matches - r.mismatches;
      identity = r.matches / compared;
      if (!best || score > best.score ||
          (score === best.score && identity > best.identity)) {
        best = {
          offset: offset, score: score, identity: identity,
          matches: r.matches, mismatches: r.mismatches, compared: compared
        };
      }
    }
    return best;
  }

  /**
   * 順方向と逆相補方向の両方で照合し、適合する向きを採用する（要件5）。
   * 戻り値の direction は「元の読取方向」。
   */
  function align(read, target, options) {
    var opts = {
      minOverlap: (options && options.minOverlap) || DEFAULTS.minOverlap,
      minIdentity: (options && options.minIdentity != null) ? options.minIdentity : DEFAULTS.minIdentity
    };
    var abif = root.AB1.abif;

    var fwd = bestOffset(read.seq, target.seq, opts);
    var rcSeq = abif.reverseComplement(read.seq);
    var rev = bestOffset(rcSeq, target.seq, opts);

    var useReverse;
    if (fwd && rev) useReverse = (rev.score > fwd.score);
    else if (rev) useReverse = true;
    else if (fwd) useReverse = false;
    else {
      return {
        aligned: false, direction: null, best: null,
        reason: '比較できる塩基が足りません（最小オーバーラップ ' + opts.minOverlap + ' 塩基）'
      };
    }

    var best = useReverse ? rev : fwd;
    var aligned = best.identity >= opts.minIdentity;

    return {
      aligned: aligned,
      direction: useReverse ? 'Reverse' : 'Forward',
      // 採用した向きに揃えた状態でのオフセット
      offset: best.offset,
      identity: best.identity,
      score: best.score,
      matches: best.matches,
      mismatches: best.mismatches,
      compared: best.compared,
      forward: fwd,
      reverse: rev,
      minIdentity: opts.minIdentity,
      reason: aligned ? null :
        '一致率 ' + (best.identity * 100).toFixed(1) + '% が採用基準 ' +
        (opts.minIdentity * 100).toFixed(0) + '% 未満です'
    };
  }

  var api = { align: align, bestOffset: bestOffset, DEFAULTS: DEFAULTS };

  root.AB1 = root.AB1 || {};
  root.AB1.align = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
