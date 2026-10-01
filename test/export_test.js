/*
 * test/export_test.js - 実データから .xlsx を生成して中身を確認する
 *   node test/export_test.js [出力先]
 */
'use strict';
const fs = require('fs');
const path = require('path');

require('../js/abif.js');
require('../js/align.js');
require('../js/call.js');
require('../js/xlsx.js');
require('../js/export.js');
const targetLib = require('../js/target.js');
const AB1 = globalThis.AB1;

const dir = path.join(__dirname, '..');
const out = process.argv[2] || path.join(require('os').tmpdir(), 'ab1_genotype_test.xlsx');
const target = targetLib.parseOne(
  'ACATAGGTAGTTTGGAGAATTGTTCATTACTGAAATCACTGTCCCTCAGTTCACCGGTCTTGTCTGCTTCGTC[G]TCAAAAACAGCTTGACTGGGATGACCGAAGTGCTTGTTCAGCTCGGCTCGGATTTCCTGGTCTTGGAGCTGTTTT',
  'PPARGC1A');

const results = fs.readdirSync(dir).filter(f => /\.(ab1|abi)$/i.test(f)).sort().map(f => {
  const b = fs.readFileSync(path.join(dir, f));
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  let sample;
  try { sample = { fileName: f, read: AB1.abif.parse(ab) }; }
  catch (e) { sample = { fileName: f, error: e.message }; }
  return AB1.call.analyze(sample, target, {});
});

const rows = AB1.export.toRows(results);
console.log('列数: ' + rows[0].length + '  行数: ' + rows.length + '（ヘッダ1 + サンプル' + (rows.length - 1) + '）');
console.log(rows[0].join(' | '));
rows.slice(1).forEach(r => console.log(r.map(v => v === null ? '' : v).join(' | ')));

const bytes = AB1.export.buildWorkbook(results, 'Genotype');
fs.writeFileSync(out, Buffer.from(bytes));
console.log('\n書き出し: ' + out + ' (' + bytes.length + ' bytes)');
