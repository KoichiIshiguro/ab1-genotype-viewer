/*
 * call.js - 対象位置のホモ／ヘテロ／N判定
 *
 * 強度指標の定義（要件8.1で実装仕様として明記することを求められている箇所）:
 *   対象位置のピーク位置(PLOC)における A/T/G/C 4チャンネルの値を負値を0に丸めて合計した
 *   「合計蛍光強度」を、最小蛍光強度の比較対象とする。
 *   比率も同じ合計で正規化するため、閾値と比率の分母が一致する。
 *   （最大ピーク高を基準にするとヘテロ接合体が不利になるため合計を採る）
 */
(function (root) {
  'use strict';

  var BASES = ['A', 'T', 'G', 'C'];   // 遺伝型表記はこの順に固定（要件8.2の表記例に合わせる）

  var DEFAULTS = {
    minIntensity: 500,   // 合計蛍光強度の下限。これ未満は N
    minCallRatio: 0.20,  // 要件8.2の初期値候補。「以上」で採用
    minOverlap: 30,
    minIdentity: 0.80
  };

  /** 向きを揃えたリードの index 位置における蛍光強度・比率・Qualityを取る */
  function measure(read, index) {
    if (index < 0 || index >= read.seq.length) return null;
    var scan = read.ploc[index];
    var intensities = {}, total = 0, max = 0, i, b, v;

    for (i = 0; i < BASES.length; i++) {
      b = BASES[i];
      v = read.traces[b][scan];
      if (!(v > 0)) v = 0;          // ベースライン補正による負値は0として扱う
      intensities[b] = v;
      total += v;
      if (v > max) max = v;
    }

    var ratios = {};
    for (i = 0; i < BASES.length; i++) {
      b = BASES[i];
      ratios[b] = total > 0 ? intensities[b] / total : 0;
    }

    return {
      index: index,
      scan: scan,
      base: read.seq.charAt(index),
      quality: read.quality ? read.quality[index] : null,
      intensities: intensities,
      ratios: ratios,
      total: total,
      max: max
    };
  }

  /** 比率から遺伝型を決める（要件9） */
  function genotypeFromRatios(ratios, minCallRatio) {
    var candidates = BASES.filter(function (b) { return ratios[b] >= minCallRatio; });
    if (candidates.length === 0) {
      return { genotype: 'N', zygosity: '判定不能', status: 'no_candidate', candidates: candidates };
    }
    if (candidates.length === 1) {
      return {
        genotype: candidates[0] + '/' + candidates[0],
        zygosity: 'ホモ', status: 'ok', candidates: candidates
      };
    }
    if (candidates.length === 2) {
      return {
        genotype: candidates[0] + '/' + candidates[1],
        zygosity: 'ヘテロ', status: 'ok', candidates: candidates
      };
    }
    return {
      genotype: candidates.join('/'),
      zygosity: '要確認', status: 'ambiguous', candidates: candidates
    };
  }

  function settingsWithDefaults(s) {
    var out = {}, k;
    for (k in DEFAULTS) out[k] = (s && s[k] != null && s[k] !== '') ? Number(s[k]) : DEFAULTS[k];
    return out;
  }

  /**
   * 1サンプル × 1ターゲットを解析する。
   * sample: { fileName, read(=parse結果) } または { fileName, error }
   */
  function analyze(sample, target, settings) {
    var abif = root.AB1.abif, aligner = root.AB1.align;
    var cfg = settingsWithDefaults(settings);

    var result = {
      fileName: sample.fileName,
      sampleName: (sample.read && sample.read.sampleName) || '',
      label: sample.fileName.replace(/\.(ab1|abi)$/i, ''),
      targetName: target ? target.name : '',
      mode: target ? 'target' : 'scan',
      displayable: false,
      status: null,
      message: '',
      flags: [],
      genotype: '—',
      zygosity: '',
      direction: '—',
      directionNote: '',
      aligned: false,
      alignment: null,
      oriented: null,
      offset: null,
      site: null,
      scaleRef: 1000,
      settings: cfg
    };

    if (sample.error) {
      result.status = 'load_error';
      result.zygosity = '読込失敗';
      result.message = sample.error;
      return result;
    }

    var read = sample.read;

    if (!read.hasQuality) result.flags.push('Quality score(PCON)がファイルに含まれていません');

    if (read.callableBases === 0) {
      result.status = 'no_basecall';
      result.zygosity = '判定なし';
      result.message = 'ベースコールされた塩基がありません（シーケンス失敗）';
      return result;
    }

    if (!target) return scanAllPositions(result, read, cfg);

    var al = aligner.align(read, target, cfg);
    result.alignment = al;
    result.direction = al.direction || '—';

    var oriented = (al.direction === 'Reverse') ? abif.reverseComplementRead(read) : read;
    result.oriented = oriented;
    result.scaleRef = abif.scaleReference(oriented);
    result.directionNote = (al.direction === 'Reverse') ? '逆相補して表示' : 'そのまま表示';

    if (!al.aligned) {
      result.status = 'unaligned';
      result.zygosity = 'アライメント不可';
      result.directionNote = '';
      result.direction = '—';
      result.message = 'ターゲットシーケンスとアライメントできませんでした';
      result.oriented = read;          // 向きを確定できないので元データのまま
      result.scaleRef = abif.scaleReference(read);
      return result;
    }

    result.aligned = true;
    result.displayable = true;
    result.offset = al.offset;

    var index = al.offset + target.variantIndex;
    if (index < 0 || index >= oriented.seq.length) {
      result.status = 'not_reached';
      result.zygosity = '判読不能';
      result.message = '対象位置を判読できません（波形が対象位置まで届いていません）';
      return result;
    }

    var site = measure(oriented, index);
    result.site = site;

    if (site.total < cfg.minIntensity) {
      result.status = 'low_signal';
      result.genotype = 'N';
      result.zygosity = '判定不能';
      result.message = '対象位置の合計蛍光強度 ' + site.total +
                       ' が最小蛍光強度 ' + cfg.minIntensity + ' 未満です';
      return result;
    }

    var g = genotypeFromRatios(site.ratios, cfg.minCallRatio);
    result.genotype = g.genotype;
    result.zygosity = g.zygosity;
    result.candidates = g.candidates;
    result.status = g.status;

    if (g.status === 'ambiguous') {
      result.message = '閾値以上の塩基が3種類以上あります（要確認）';
    } else if (g.status === 'no_candidate') {
      result.message = '最小コール比率 ' + cfg.minCallRatio + ' 以上の塩基がありません';
    } else {
      result.message = g.candidates.map(function (b) {
        return b + ' ' + Math.round(site.ratios[b] * 100) + '%';
      }).join('・') + ' が最小コール比率 ' + Math.round(cfg.minCallRatio * 100) +
        '% 以上のため、' + g.genotype + '（' + g.zygosity + '）と判定';
    }
    if (g.status === 'ok') {
      var unexpected = g.candidates.filter(function (b) { return target.alleles.indexOf(b) < 0; });
      if (unexpected.length) {
        result.flags.push('角括弧で指定していない塩基が検出されました: ' + unexpected.join(', ') + '（要確認）');
      }
    }

    return result;
  }

  /**
   * ターゲット未指定のときの処理。
   * 読めている全塩基位置に同じ閾値を当てて、ヘテロ（閾値以上の塩基が2種類）の位置を拾う。
   * 最小蛍光強度を満たす位置だけを判定対象にする。
   * Quality score は表示のみに使い、判定の足切りには使わない
   * （ヘテロ位置はベースコーラーの仕様上かならずQualityが下がるため）。
   */
  function scanAllPositions(result, read, cfg) {
    var abif = root.AB1.abif;

    result.mode = 'scan';
    result.displayable = true;
    result.oriented = read;              // 揃える相手がないのでそのまま表示する
    result.offset = 0;
    result.scaleRef = abif.scaleReference(read);
    result.direction = '—';
    result.directionNote = 'ターゲット未指定';

    var hetSites = [], ambiguousSites = [], evaluated = 0, i, site, g;

    for (i = 0; i < read.seq.length; i++) {
      site = measure(read, i);
      if (site.total < cfg.minIntensity) continue;
      evaluated++;
      g = genotypeFromRatios(site.ratios, cfg.minCallRatio);
      if (g.candidates.length === 2) {
        hetSites.push({ index: i, genotype: g.genotype, zygosity: g.zygosity, site: site });
      } else if (g.candidates.length >= 3) {
        ambiguousSites.push({ index: i, genotype: g.genotype, zygosity: g.zygosity, site: site });
      }
    }

    result.hetSites = hetSites;
    result.ambiguousSites = ambiguousSites;
    result.evaluated = evaluated;

    if (evaluated === 0) {
      result.status = 'no_evaluable';
      result.genotype = '—';
      result.zygosity = '判定不能';
      result.message = '最小蛍光強度 ' + cfg.minIntensity + ' を満たす位置がありません';
      return result;
    }

    result.status = 'scan';
    result.genotype = hetSites.length ? String(hetSites.length) + '箇所' : '—';
    result.zygosity = hetSites.length ? 'ヘテロあり' : 'ホモのみ';
    result.message = hetSites.length
      ? 'ヘテロと判定した位置が ' + hetSites.length + ' 箇所あります（判定対象 ' + evaluated + ' 塩基 / 全 ' +
        read.seq.length + ' 塩基）'
      : 'ヘテロと判定した位置はありません（判定対象 ' + evaluated + ' 塩基 / 全 ' +
        read.seq.length + ' 塩基）';

    if (ambiguousSites.length) {
      result.flags.push('閾値以上の塩基が3種類以上の位置が ' + ambiguousSites.length + ' 箇所あります（要確認）');
    }
    return result;
  }

  var api = {
    BASES: BASES,
    DEFAULTS: DEFAULTS,
    scanAllPositions: scanAllPositions,
    measure: measure,
    genotypeFromRatios: genotypeFromRatios,
    settingsWithDefaults: settingsWithDefaults,
    analyze: analyze
  };

  root.AB1 = root.AB1 || {};
  root.AB1.call = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
