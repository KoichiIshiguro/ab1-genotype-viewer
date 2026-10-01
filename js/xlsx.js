/*
 * xlsx.js - 依存ライブラリなしの最小 .xlsx ライター
 *
 * AB1データを外部へ送信しない要件（要件2）があるため、CDN等の外部取得を行わず
 * ZIP(無圧縮 store)とSpreadsheetML生成を自前で持つ。
 */
(function (root) {
  'use strict';

  var CRC_TABLE = (function () {
    var table = new Int32Array(256), c, n, k;
    for (n = 0; n < 256; n++) {
      c = n;
      for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0 ^ (-1), i;
    for (i = 0; i < bytes.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xFF];
    return (c ^ (-1)) >>> 0;
  }

  function utf8(str) {
    return new Uint8Array(new TextEncoder().encode(str));
  }

  function Builder() { this.bytes = []; }
  Builder.prototype.u16 = function (v) { this.bytes.push(v & 0xFF, (v >>> 8) & 0xFF); return this; };
  Builder.prototype.u32 = function (v) {
    this.bytes.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF); return this;
  };
  Builder.prototype.raw = function (arr) {
    var i;
    for (i = 0; i < arr.length; i++) this.bytes.push(arr[i]);
    return this;
  };
  Builder.prototype.done = function () { return new Uint8Array(this.bytes); };

  function dosDateTime(d) {
    return {
      time: ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F),
      date: (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F)
    };
  }

  /** files: [{name, data(Uint8Array)}] を無圧縮ZIPにまとめる */
  function zip(files) {
    var now = dosDateTime(new Date());
    var out = new Builder(), central = [], offset = 0, i;

    for (i = 0; i < files.length; i++) {
      var f = files[i], nameBytes = utf8(f.name), crc = crc32(f.data);
      var local = new Builder();
      local.u32(0x04034B50).u16(20).u16(0x0800).u16(0)
           .u16(now.time).u16(now.date).u32(crc).u32(f.data.length).u32(f.data.length)
           .u16(nameBytes.length).u16(0).raw(nameBytes).raw(f.data);
      var localBytes = local.done();
      out.raw(localBytes);
      central.push({ name: nameBytes, crc: crc, size: f.data.length, offset: offset });
      offset += localBytes.length;
    }

    var cdStart = offset, cd = new Builder();
    for (i = 0; i < central.length; i++) {
      var c = central[i];
      cd.u32(0x02014B50).u16(20).u16(20).u16(0x0800).u16(0)
        .u16(now.time).u16(now.date).u32(c.crc).u32(c.size).u32(c.size)
        .u16(c.name.length).u16(0).u16(0).u16(0).u16(0).u32(0).u32(c.offset).raw(c.name);
    }
    var cdBytes = cd.done();
    out.raw(cdBytes);
    out.u32(0x06054B50).u16(0).u16(0).u16(central.length).u16(central.length)
       .u32(cdBytes.length).u32(cdStart).u16(0);
    return out.done();
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;');
  }

  function colName(n) {   // 0 -> A
    var s = '';
    n = n + 1;
    while (n > 0) {
      var m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function cell(ref, value) {
    if (value === null || value === undefined || value === '') {
      return '<c r="' + ref + '"/>';
    }
    if (typeof value === 'number' && isFinite(value)) {
      return '<c r="' + ref + '"><v>' + value + '</v></c>';
    }
    return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + esc(value) + '</t></is></c>';
  }

  /** rows: 1行目をヘッダとする二次元配列 */
  function buildSheet(rows, colWidths) {
    var xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
    if (colWidths && colWidths.length) {
      xml += '<cols>';
      colWidths.forEach(function (w, i) {
        xml += '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>';
      });
      xml += '</cols>';
    }
    xml += '<sheetData>';
    rows.forEach(function (row, r) {
      xml += '<row r="' + (r + 1) + '">';
      row.forEach(function (v, c) { xml += cell(colName(c) + (r + 1), v); });
      xml += '</row>';
    });
    xml += '</sheetData></worksheet>';
    return xml;
  }

  function build(rows, options) {
    var opts = options || {};
    var sheetName = esc(opts.sheetName || 'Result');
    var files = [
      { name: '[Content_Types].xml', data: utf8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '</Types>') },
      { name: '_rels/.rels', data: utf8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>') },
      { name: 'xl/workbook.xml', data: utf8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="' + sheetName + '" sheetId="1" r:id="rId1"/></sheets></workbook>') },
      { name: 'xl/_rels/workbook.xml.rels', data: utf8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '</Relationships>') },
      { name: 'xl/worksheets/sheet1.xml', data: utf8(buildSheet(rows, opts.colWidths)) }
    ];
    return zip(files);
  }

  var api = { build: build, zip: zip, crc32: crc32, colName: colName };

  root.AB1 = root.AB1 || {};
  root.AB1.xlsx = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
