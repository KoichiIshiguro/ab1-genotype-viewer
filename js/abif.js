/*
 * abif.js - ABIF (Applied Biosystems .ab1/.abi) reader
 *
 * ブラウザでは <script src> で読み込み window.AB1.abif に、
 * Node では require() で module.exports に生える。
 */
(function (root) {
  'use strict';

  // ABIF element types (ABIF file format specification, Applied Biosystems)
  var T_BYTE = 1, T_CHAR = 2, T_WORD = 3, T_SHORT = 4, T_LONG = 5,
      T_PSTRING = 18, T_CSTRING = 19;

  function str4(dv, off) {
    return String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1),
                               dv.getUint8(off + 2), dv.getUint8(off + 3));
  }

  function readDirEntry(dv, off) {
    return {
      name: str4(dv, off),
      number: dv.getInt32(off + 4),
      elementType: dv.getUint16(off + 8),
      elementSize: dv.getUint16(off + 10),
      numElements: dv.getInt32(off + 12),
      dataSize: dv.getInt32(off + 16),
      dataOffset: dv.getInt32(off + 20),
      selfOffset: off
    };
  }

  // dataSize <= 4 の場合、値は dataOffset フィールドの位置に直接埋まっている
  function dataBase(e) {
    return e.dataSize > 4 ? e.dataOffset : e.selfOffset + 20;
  }

  function readText(dv, e) {
    var base = dataBase(e), i, s = '', start = 0, len = e.dataSize;
    if (e.elementType === T_PSTRING) { start = 1; len = dv.getUint8(base); }
    else if (e.elementType === T_CSTRING) { len = e.dataSize - 1; }
    for (i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(base + start + i));
    return s;
  }

  function readInt16Array(dv, e) {
    var base = dataBase(e), n = e.numElements, out = new Int16Array(n), i;
    for (i = 0; i < n; i++) out[i] = dv.getInt16(base + i * 2);
    return out;
  }

  function readUint16Array(dv, e) {
    var base = dataBase(e), n = e.numElements, out = new Uint16Array(n), i;
    for (i = 0; i < n; i++) out[i] = dv.getUint16(base + i * 2);
    return out;
  }

  function readByteArray(dv, e) {
    var base = dataBase(e), n = e.numElements, out = new Uint8Array(n), i;
    for (i = 0; i < n; i++) out[i] = dv.getUint8(base + i);
    return out;
  }

  /**
   * ArrayBuffer を解析して AB1 の中身を返す。
   * 解析不能な場合は Error を投げる（= 要件13「AB1読込失敗」）。
   */
  function parse(buffer) {
    var dv = new DataView(buffer);

    if (dv.byteLength < 34 || str4(dv, 0) !== 'ABIF') {
      throw new Error('ABIF署名がありません。AB1／ABIファイルではない可能性があります');
    }

    var version = dv.getUint16(4);
    var rootEntry = readDirEntry(dv, 6);
    var entries = {}, i, e;

    if (rootEntry.dataOffset + rootEntry.numElements * 28 > dv.byteLength) {
      throw new Error('ファイルが途中で切れています（ディレクトリ領域が不足）');
    }
    for (i = 0; i < rootEntry.numElements; i++) {
      e = readDirEntry(dv, rootEntry.dataOffset + i * 28);
      entries[e.name + '/' + e.number] = e;
    }

    function get() {   // get('PBAS', 1, 2) → 最初に見つかったもの
      var name = arguments[0], k;
      for (k = 1; k < arguments.length; k++) {
        var hit = entries[name + '/' + arguments[k]];
        if (hit) return hit;
      }
      return null;
    }
    function text(name) {
      var hit = get(name, 1);
      return hit ? readText(dv, hit) : '';
    }

    // チャンネル順（DATA9,10,11,12 が何の塩基か）。ファイルによって ACGT ではない
    var fwo = text('FWO_');
    if (!/^[ACGT]{4}$/.test(fwo)) {
      throw new Error('チャンネル順（FWO_）を読み取れません');
    }

    var basesEntry = get('PBAS', 1, 2);
    var plocEntry  = get('PLOC', 1, 2);
    var pconEntry  = get('PCON', 1, 2);
    if (!basesEntry) throw new Error('ベースコール配列（PBAS）がありません');
    if (!plocEntry)  throw new Error('ピーク位置（PLOC）がありません');

    var traces = {}, missing = [], n;
    for (i = 0; i < 4; i++) {
      var dataEntry = get('DATA', 9 + i);
      if (!dataEntry) { missing.push('DATA' + (9 + i)); continue; }
      traces[fwo.charAt(i)] = readInt16Array(dv, dataEntry);
    }
    if (missing.length) throw new Error('波形データがありません（' + missing.join(', ') + '）');

    n = traces[fwo.charAt(0)].length;
    for (i = 1; i < 4; i++) {
      if (traces[fwo.charAt(i)].length !== n) {
        throw new Error('4色の波形データ長が一致しません');
      }
    }

    var seq = readText(dv, basesEntry).toUpperCase();
    var ploc = readUint16Array(dv, plocEntry);
    var quality = pconEntry ? readByteArray(dv, pconEntry) : null;

    if (ploc.length < seq.length) {
      throw new Error('ピーク位置の数がベースコール数に足りません');
    }

    var snr = null, snrEntry = get('S/N%', 1);
    if (snrEntry) snr = Array.prototype.slice.call(readInt16Array(dv, snrEntry));

    var callable = 0;
    for (i = 0; i < seq.length; i++) if (seq.charAt(i) !== 'N') callable++;

    return {
      version: version,
      sampleName: text('SMPL'),
      machine: text('MCHN'),
      runDate: text('RUND'),
      channelOrder: fwo,
      seq: seq,
      ploc: ploc,
      quality: quality,
      traces: traces,
      nScans: n,
      snr: snr,
      callableBases: callable,
      hasQuality: !!pconEntry
    };
  }

  var COMPLEMENT = { A: 'T', T: 'A', G: 'C', C: 'G', N: 'N', '-': '-' };

  function complementBase(b) {
    return COMPLEMENT[b] || 'N';
  }

  function reverseComplement(s) {
    var out = '', i;
    for (i = s.length - 1; i >= 0; i--) out += complementBase(s.charAt(i));
    return out;
  }

  /**
   * 読み取ったデータを逆相補方向へ変換する。
   * 配列・Quality・ピーク位置・A/T/G/C チャンネルすべてを変換する（要件5）。
   */
  function reverseComplementRead(read) {
    var S = read.seq.length, n = read.nScans, i, b;

    var ploc = new Uint16Array(S);
    for (i = 0; i < S; i++) ploc[i] = (n - 1) - read.ploc[S - 1 - i];

    var quality = null;
    if (read.quality) {
      quality = new Uint8Array(S);
      for (i = 0; i < S; i++) quality[i] = read.quality[S - 1 - i];
    }

    // 向きを変えた配列の A チャンネルは、元データの T チャンネルを反転したもの
    var traces = {};
    ['A', 'T', 'G', 'C'].forEach(function (base) {
      var src = read.traces[complementBase(base)], dst = new Int16Array(n), k;
      for (k = 0; k < n; k++) dst[k] = src[n - 1 - k];
      traces[base] = dst;
    });

    var out = {};
    for (b in read) if (Object.prototype.hasOwnProperty.call(read, b)) out[b] = read[b];
    out.seq = reverseComplement(read.seq);
    out.ploc = ploc;
    out.quality = quality;
    out.traces = traces;
    return out;
  }

  /**
   * 波形の縦スケール基準値。
   * ソルト・プライマーダイマー由来のスパイクで潰れないよう、
   * ベースコール位置の主ピーク高の95パーセンタイルを使う。
   */
  function scaleReference(read) {
    var vals = [], i, p, m, b, v;
    for (i = 0; i < read.seq.length; i++) {
      p = read.ploc[i];
      m = 0;
      for (b in read.traces) {
        v = read.traces[b][p];
        if (v > m) m = v;
      }
      vals.push(m);
    }
    if (!vals.length) return 1000;
    vals.sort(function (a, b2) { return a - b2; });
    return Math.max(1, vals[Math.floor(vals.length * 0.95)]);
  }

  var api = {
    parse: parse,
    reverseComplement: reverseComplement,
    complementBase: complementBase,
    reverseComplementRead: reverseComplementRead,
    scaleReference: scaleReference
  };

  root.AB1 = root.AB1 || {};
  root.AB1.abif = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
