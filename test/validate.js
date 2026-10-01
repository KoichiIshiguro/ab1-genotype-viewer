/*
 * test/validate.js - 実AB1ファイルでコアロジックを検証する
 *
 *   node test/validate.js [ab1を置いたディレクトリ] [ターゲット配列]
 *
 * ターゲット配列を省略した場合は js/app.js のデフォルトと同じ配列を使う。
 */
'use strict';
const fs = require('fs');
const path = require('path');

require('../js/abif.js');
require('../js/align.js');
require('../js/call.js');
const targetLib = require('../js/target.js');
const AB1 = globalThis.AB1;

const dir = process.argv[2] || path.join(__dirname, '..');
const targetText = process.argv[3] || 'ACATAGGTAGTTTGGAGAATTGTTCATTACTGAAATCACTGTCCCTCAGTTCACCGGTCTTGTCTGCTTCGTC[G]TCAAAAACAGCTTGACTGGGATGACCGAAGTGCTTGTTCAGCTCGGCTCGGATTTCCTGGTCTTGGAGCTGTTTT';

const target = targetLib.parseAll(targetText, 'PPARGC1A')[0];
console.log('target: ' + target.name + '  左' + target.left.length + 'bp + [' +
            target.alleles.join('/') + '] + 右' + target.right.length + 'bp' +
            '  variantIndex=' + target.variantIndex);

const files = fs.readdirSync(dir).filter(f => /\.(ab1|abi)$/i.test(f)).sort();
if (!files.length) { console.error('AB1ファイルが見つかりません: ' + dir); process.exit(1); }

const rows = [];
for (const f of files) {
  const buf = fs.readFileSync(path.join(dir, f));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  let sample;
  try {
    sample = { fileName: f, read: AB1.abif.parse(ab) };
  } catch (e) {
    sample = { fileName: f, error: e.message };
  }
  const r = AB1.call.analyze(sample, target, {});
  rows.push(r);
}

const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);

console.log('');
console.log(pad('file', 34) + pad('status', 15) + pad('geno', 7) + pad('zyg', 12) +
            pad('dir', 9) + padl('ident', 7) + padl('off', 6) + padl('idx', 6) +
            padl('total', 7) + padl('Q', 4) + '  ratios A/T/G/C');
console.log('-'.repeat(150));
for (const r of rows) {
  const al = r.alignment;
  const s = r.site;
  console.log(
    pad(r.label.slice(0, 33), 34) +
    pad(r.status, 15) +
    pad(r.genotype, 7) +
    pad(r.zygosity, 12) +
    pad(r.direction, 9) +
    padl(al && al.identity != null ? (al.identity * 100).toFixed(1) + '%' : '-', 7) +
    padl(r.offset != null ? r.offset : '-', 6) +
    padl(s ? s.index : '-', 6) +
    padl(s ? s.total : '-', 7) +
    padl(s && s.quality != null ? s.quality : '-', 4) + '  ' +
    (s ? AB1.call.BASES.map(b => b + ':' + s.ratios[b].toFixed(2)).join(' ') : r.message)
  );
}

// 方向変換の自己検証: 逆相補を2回かけると元に戻る
console.log('\n--- 逆相補変換の検証 ---');
for (const f of files) {
  const buf = fs.readFileSync(path.join(dir, f));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  let read;
  try { read = AB1.abif.parse(ab); } catch (e) { continue; }
  const twice = AB1.abif.reverseComplementRead(AB1.abif.reverseComplementRead(read));
  let ok = twice.seq === read.seq;
  for (let i = 0; i < read.seq.length && ok; i++) ok = twice.ploc[i] === read.ploc[i];
  for (const b of ['A', 'T', 'G', 'C']) {
    if (!ok) break;
    for (let k = 0; k < read.nScans; k++) {
      if (twice.traces[b][k] !== read.traces[b][k]) { ok = false; break; }
    }
  }
  // 逆相補1回での対応関係も確認: 反転後 index i の A 強度 == 元 index S-1-i の T 強度
  const rc = AB1.abif.reverseComplementRead(read);
  const S = read.seq.length;
  let ok2 = true;
  for (let i = 0; i < S && ok2; i++) {
    const j = S - 1 - i;
    ok2 = rc.traces.A[rc.ploc[i]] === read.traces.T[read.ploc[j]] &&
          rc.traces.G[rc.ploc[i]] === read.traces.C[read.ploc[j]] &&
          rc.quality[i] === read.quality[j];
  }
  console.log((ok && ok2 ? 'PASS  ' : 'FAIL  ') + f + (ok ? '' : ' (二重反転不一致)') + (ok2 ? '' : ' (チャンネル対応不一致)'));
}

// 逆相補方向の経路の検証:
// ターゲット配列を逆相補にすると、同じサンプルが Reverse として検出され、
// 遺伝型は相補塩基、蛍光強度は対応チャンネルが入れ替わって出るはず。
console.log('\n--- 逆方向（Reverse）経路の検証 ---');
const rcTargetText =
  AB1.abif.reverseComplement(target.right) + '[' +
  target.alleles.map(a => AB1.abif.complementBase(a)).join('/') + ']' +
  AB1.abif.reverseComplement(target.left);
const rcTarget = targetLib.parseOne(rcTargetText, target.name + '-RC');
const COMP = { A: 'T', T: 'A', G: 'C', C: 'G' };
for (const f of files) {
  const buf = fs.readFileSync(path.join(dir, f));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  let sample;
  try { sample = { fileName: f, read: AB1.abif.parse(ab) }; }
  catch (e) { sample = { fileName: f, error: e.message }; }
  const fwd = AB1.call.analyze(sample, target, {});
  const rev = AB1.call.analyze(sample, rcTarget, {});
  if (!fwd.aligned) continue;
  const expectGeno = fwd.genotype.split('/').map(b => COMP[b] || b).sort().join('/');
  const gotGeno = rev.genotype.split('/').sort().join('/');
  const intOk = fwd.site && rev.site &&
    ['A', 'T', 'G', 'C'].every(b => fwd.site.intensities[b] === rev.site.intensities[COMP[b]]);
  const dirOk = fwd.direction === 'Forward' && rev.direction === 'Reverse';
  console.log(((dirOk && gotGeno === expectGeno && intOk) ? 'PASS  ' : 'FAIL  ') +
    f.padEnd(36) + 'Forward:' + fwd.genotype + '(' + fwd.direction + ')  ' +
    'RCターゲット:' + rev.genotype + '(' + rev.direction + ')  ' +
    '期待:' + expectGeno + '  強度の入れ替わり:' + (intOk ? 'OK' : 'NG'));
}

// ターゲット未指定（全塩基スキャン）モードの検証
console.log('\n--- ターゲット未指定モード（各ファイルのホモ／ヘテロ判定）---');
console.log('file'.padEnd(34) + 'status'.padEnd(13) + 'judge'.padEnd(14) +
            'evaluated'.padStart(10) + 'het'.padStart(5) + '  ヘテロ位置（位置:遺伝型）');
console.log('-'.repeat(130));
for (const f of files) {
  const buf = fs.readFileSync(path.join(dir, f));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  let sample;
  try { sample = { fileName: f, read: AB1.abif.parse(ab) }; }
  catch (e) { sample = { fileName: f, error: e.message }; }
  const r = AB1.call.analyze(sample, null, {});
  const het = (r.hetSites || []).map(h => (h.index + 1) + ':' + h.genotype);
  console.log(
    r.label.slice(0, 33).padEnd(34) + String(r.status).padEnd(13) +
    String(r.zygosity).padEnd(14) + String(r.evaluated != null ? r.evaluated : '-').padStart(10) +
    String(het.length).padStart(5) + '  ' +
    (het.length ? het.slice(0, 8).join(' ') + (het.length > 8 ? ' …' : '') : r.message));
}
