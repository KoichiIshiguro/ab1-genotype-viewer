/*
 * test/rules_test.js - 要件に書かれている判定ルールをそのまま検証する
 *   node test/rules_test.js
 */
'use strict';
require('../js/abif.js');
require('../js/align.js');
require('../js/call.js');
const targetLib = require('../js/target.js');
const AB1 = globalThis.AB1;

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name +
    (ok ? '' : '\n        期待: ' + JSON.stringify(expected) + '\n        実際: ' + JSON.stringify(actual)));
  ok ? pass++ : fail++;
}
function throws(name, fn, re) {
  try { fn(); console.log('FAIL  ' + name + '（エラーが出ませんでした）'); fail++; }
  catch (e) {
    const ok = re.test(e.message);
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + '  → ' + e.message);
    ok ? pass++ : fail++;
  }
}

console.log('--- 要件8.2 の例（最小コール比率 0.20）---');
const g = (r) => AB1.call.genotypeFromRatios(r, 0.20);
check('A0.00 T0.25 G0.00 C0.75 → T/C ヘテロ',
  (x => [x.genotype, x.zygosity])(g({ A: 0.00, T: 0.25, G: 0.00, C: 0.75 })), ['T/C', 'ヘテロ']);
check('A0.00 T0.19 G0.00 C0.81 → C/C ホモ',
  (x => [x.genotype, x.zygosity])(g({ A: 0.00, T: 0.19, G: 0.00, C: 0.81 })), ['C/C', 'ホモ']);
check('閾値ちょうど0.20は採用する（T0.20 C0.80 → T/C）',
  (x => [x.genotype, x.zygosity])(g({ A: 0.00, T: 0.20, G: 0.00, C: 0.80 })), ['T/C', 'ヘテロ']);
check('閾値直下は不採用（T0.1999 C0.8001 → C/C）',
  (x => [x.genotype, x.zygosity])(g({ A: 0.00, T: 0.1999, G: 0.00, C: 0.8001 })), ['C/C', 'ホモ']);
check('3種類以上は要確認',
  (x => [x.zygosity, x.status])(g({ A: 0.30, T: 0.30, G: 0.30, C: 0.10 })), ['要確認', 'ambiguous']);
check('遺伝型の表記はA/T/G/Cの順（G0.5 A0.5 → A/G）',
  g({ A: 0.50, T: 0.00, G: 0.50, C: 0.00 }).genotype, 'A/G');

console.log('\n--- ターゲット配列の記法 ---');
check('候補2種', (t => [t.left, t.alleles, t.right, t.variantIndex])(
  targetLib.parseOne('ATCGCCATG[A/G]ATTCCTGA')), ['ATCGCCATG', ['A', 'G'], 'ATTCCTGA', 9]);
check('候補1種', (t => [t.alleles, t.seq])(
  targetLib.parseOne('ATCGCCATG[G]ATTCCTGA')), [['G'], 'ATCGCCATGNATTCCTGA']);
check('空白・改行・小文字を吸収', targetLib.parseOne(' atcgccatg[a/g]\nattcctga ').seq,
  'ATCGCCATGNATTCCTGA');
throws('角括弧なしはエラー', () => targetLib.parseOne('ATCGCCATGAATTCCTGA'), /角括弧/);
throws('角括弧が複数はエラー', () => targetLib.parseOne('ATCG[A/G]CCATG[C]ATTCCTGA'), /1か所/);
throws('前後が短すぎるとエラー', () => targetLib.parseOne('ATCG[A/G]ATTCCTGA'), /塩基以上/);
throws('候補が3種類はエラー', () => targetLib.parseOne('ATCGCCATG[A/G/C]ATTCCTGA'), /2種類まで/);
throws('ACGT以外はエラー', () => targetLib.parseOne('ATCGCCXTG[A/G]ATTCCTGA'), /A\/C\/G\/T/);

console.log('\n--- 複数ターゲット（FASTA） ---');
const fa = targetLib.parseAll('>ACTN3_R577X\nGGTGAACTGCTGGAGCC[C/T]\nGAGTGCTCAGGCC\n\n>PPARGC1A_G482S\nCTGTGGACACCTC[G/A]TCTCCACAGCTC\n');
check('FASTAの2レコードを名前つきで読む', fa.map(t => t.name), ['ACTN3_R577X', 'PPARGC1A_G482S']);
check('折り返した配列行を連結する', fa[0].seq, 'GGTGAACTGCTGGAGCCNGAGTGCTCAGGCC');
check('各レコードの対象位置', fa.map(t => t.variantIndex), [17, 13]);
check('名前のないレコードには連番', targetLib.parseAll('>\nATCGCCATG[A/G]ATTCCTGA\n>Second\nATCGCCATG[C/T]ATTCCTGA').map(t => t.name),
  ['Target-1', 'Second']);
check('> が無ければ従来どおり1行＝1ターゲット', targetLib.parseAll('ATCGCCATG[A/G]ATTCCTGA\nATCGCCATG[C/T]ATTCCTGA').map(t => t.name),
  ['Target-1', 'Target-2']);
check('空入力は空配列', targetLib.parseAll('  \n '), []);
throws('エラーにはどのレコードかを付ける', () => targetLib.parseAll('>A\nGGTGAACTGCTGGAGCCCTGAGTGCTCAGGCC\n>B\nCTGTGGACACCTC[G/A]TCTCCACAGCTC'), /^A：角括弧/);
throws('名前の重複はエラー', () => targetLib.parseAll('>X\nATCGCCATG[A/G]ATTCCTGA\n>X\nATCGCCATG[C/T]ATTCCTGA'), /重複/);

console.log('\n--- AB1読込失敗の扱い ---');
throws('ABIF署名なし', () => AB1.abif.parse(new Uint8Array(64).buffer), /ABIF署名/);

console.log('\n' + (fail === 0 ? 'すべて成功' : fail + '件 失敗') + '（' + pass + '/' + (pass + fail) + '）');
process.exit(fail === 0 ? 0 : 1);
