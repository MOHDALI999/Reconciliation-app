'use strict';
/**
 * Original-value display and the Excel export.
 *
 * The user-facing promise: what the spreadsheet showed is what the grid and
 * sheet 1 show — same text, same number/date format — and every explanation
 * lives on sheet 2, never underneath the data.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { parseWorkbook, shownValue } = require('../core/workbook.cjs');
const { reconcile, buildRow, slotsForTab } = require('../core/engine.cjs');
const { buildXlsxWorkbook, writeXlsxBuffer, writeCsv, sourceCell } = require('../core/export.cjs');

/** A workbook with real Excel formats: a formatted amount, two date formats, a numeric header. */
function formattedWorkbook(rows, headers, formats, sheetName = 'S') {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows], { cellDates: true });
  for (const [addr, z] of Object.entries(formats)) if (ws[addr]) ws[addr].z = z;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true });
}

const ordersBuf = () => formattedWorkbook(
  [
    ['OD1', new Date(Date.UTC(2026, 2, 1)), 'ABC Traders Pvt. Ltd.', 1234.5],
    ['OD2', new Date(Date.UTC(2026, 2, 2)), 'Mumbai Steel & Alloys', 900],
    ['OD3', new Date(Date.UTC(2026, 2, 3)), 'Delhi Cement Works', 15000.75],
  ],
  ['Order ID', 'Order Date', 'Customer', 'Order Amount'],
  { B2: 'dd-mmm-yyyy', B3: 'dd/mm/yyyy', B4: 'dd-mmm-yyyy', D2: '#,##0.00', D4: '#,##0.00' },
  'Orders',
);

const tallyBuf = () => formattedWorkbook(
  [
    ['OD1', new Date(Date.UTC(2026, 2, 1)), 'abc traders pvt ltd', 1234.5],
    ['OD2', new Date(Date.UTC(2026, 2, 2)), 'Cash Sale', 900],
    ['OD3', new Date(Date.UTC(2026, 2, 3)), 'Delhi Cement Work', 15000.75],
  ],
  ['Voucher Ref', 'Voucher Date', 'Party', 'Amount'],
  { B2: 'dd-mmm-yyyy', D2: '#,##0.00', D4: '0.00' },
  'Tally',
);

const settings = {
  keyA: 'Order ID', keyB: 'Voucher Ref',
  pairs: [
    { id: 'p1', colA: 'Customer', colB: 'Party', type: 'text' },
    { id: 'p2', colA: 'Order Amount', colB: 'Amount', type: 'amount' },
    { id: 'p3', colA: 'Order Date', colB: 'Voucher Date', type: 'date' },
  ],
};

function runFormatted() {
  const a = parseWorkbook(ordersBuf(), {});
  const b = parseWorkbook(tallyBuf(), {});
  const run = reconcile({
    rowsA: a.rows, rowsB: b.rows, headersA: a.headers, headersB: b.headers,
    hintsA: a.hints, hintsB: b.hints,
    displayA: a.display, displayB: b.display, formatsA: a.formats, formatsB: b.formats,
    settings,
  });
  return { a, b, run };
}

/* ------------------------------------------------------------- workbook read */

test('the reader keeps the raw value and the text the spreadsheet showed', () => {
  const a = parseWorkbook(ordersBuf(), {});
  assert.deepEqual(a.headers, ['Order ID', 'Order Date', 'Customer', 'Order Amount']);
  assert.equal(a.rows[0]['Order Amount'], 1234.5, 'raw number for the engine');
  assert.ok(a.rows[0]['Order Date'] instanceof Date, 'raw date for the engine');
  assert.equal(a.display[0]['Order Amount'], '1,234.50', 'formatted text as Excel showed it');
  assert.equal(a.display[0]['Order Date'], '01-Mar-2026');
  assert.equal(a.display[1]['Order Date'], '02/03/2026', 'per-cell format, not per-column');
  assert.equal(a.display[1]['Order Amount'], undefined, 'General "900" needs no extra text');
  assert.equal(a.formats[0]['Order Amount'], '#,##0.00');
  assert.equal(a.formats[1]['Order Date'], 'dd/mm/yyyy');
  assert.equal(shownValue(a.rows, a.display, 1, 'Order Amount'), '900');
  assert.equal(shownValue(a.rows, a.display, 0, 'Customer'), 'ABC Traders Pvt. Ltd.');
  assert.deepEqual(a.preview[1], ['OD1', '01-Mar-2026', 'ABC Traders Pvt. Ltd.', '1,234.50'], 'preview is what the user saw');
});

test('text cells cost nothing extra and CSV keeps its literal text', () => {
  const c = parseWorkbook(Buffer.from('id,date,amt,name\nOD1,01/03/2026,"1,234.50",ABC Traders\n'), {});
  assert.deepEqual(c.rows, [{ id: 'OD1', date: '01/03/2026', amt: '1,234.50', name: 'ABC Traders' }]);
  assert.deepEqual(c.display, [null], 'nothing to store: the raw value already is the shown text');
});

/* ------------------------------------------------------------ engine display */

test('the review row shows original values and keeps the parsed form for details', () => {
  const { a, b, run } = runFormatted();
  const row = buildRow(run, a.rows, b.rows, slotsForTab(run, 'all')[0], 'all');
  const amount = row.cells.find((c) => c.type === 'amount');
  const date = row.cells.find((c) => c.type === 'date');
  const text = row.cells.find((c) => c.type === 'text');
  assert.equal(amount.displayA, '1,234.50', 'as in the file');
  assert.equal(amount.parsedA, '₹1,234.50', 'engine view kept for the details');
  assert.equal(date.displayA, '01-Mar-2026');
  assert.equal(date.parsedA, '01/03/2026');
  assert.equal(text.displayA, 'ABC Traders Pvt. Ltd.');
  assert.equal(text.textLabel, 'Match');
  assert.equal(row.result, 'Matched');
  assert.equal(row.shownA['Order Amount'], '1,234.50');
  assert.equal(row.shownB['Voucher Date'], '01-Mar-2026');

  const second = buildRow(run, a.rows, b.rows, slotsForTab(run, 'all')[1], 'all');
  assert.equal(second.cells.find((c) => c.type === 'date').displayA, '02/03/2026');
  assert.equal(second.cells.find((c) => c.type === 'text').textLabel, 'Not Match', 'Cash Sale is far below 50%');
  assert.equal(second.result, 'Mismatched');
});

/* --------------------------------------------------------------- xlsx export */

test('sourceCell writes numbers and dates back with their original format', () => {
  assert.deepEqual(sourceCell(1234.5, '1,234.50', '#,##0.00'), { t: 'n', v: 1234.5, z: '#,##0.00' });
  assert.deepEqual(sourceCell(900, undefined, undefined), { t: 'n', v: 900 });
  const d = new Date(Date.UTC(2026, 2, 1));
  assert.deepEqual(sourceCell(d, '01-Mar-2026', 'dd-mmm-yyyy'), { t: 'd', v: d, z: 'dd-mmm-yyyy' });
  assert.deepEqual(sourceCell('=SUM(A1)', undefined, undefined), { t: 's', v: '=SUM(A1)' }, 'stored as text, never a formula');
  assert.equal(sourceCell(null), null);
});

test('the Excel export has one sheet per result with only the needed columns', () => {
  const { a, b, run } = runFormatted();
  const { workbook, rows } = buildXlsxWorkbook({ run, rowsA: a.rows, rowsB: b.rows, tab: 'all' });
  assert.equal(rows, 3);
  assert.deepEqual(workbook.SheetNames, ['All Data', 'Matched', 'Mismatched', 'Only in File A', 'Only in File B']);

  const back = XLSX.read(writeXlsxBuffer(workbook), { type: 'buffer', cellDates: true, cellNF: true });
  const sheet = (n) => XLSX.utils.sheet_to_json(back.Sheets[n], { header: 1, raw: false, defval: null });
  const matched = sheet('Matched');
  const mismatched = sheet('Mismatched');

  const header = [
    'Order ID (File A)', 'Voucher Ref (File B)',
    'Customer (File A)', 'Party (File B)', 'Customer Similarity %',
    'Order Amount (File A)', 'Amount (File B)', 'Order Amount Diff (A - B)',
    'Order Date (File A)', 'Voucher Date (File B)', 'Order Date Diff (A - B) days',
    'Result',
  ];
  assert.deepEqual(matched[0], header, 'no Row / Side / reason columns');
  assert.deepEqual(mismatched[0], header);
  // OD1 and OD3 match (text >= 50%), OD2 "Cash Sale" does not.
  assert.equal(matched.length, 3);
  assert.equal(mismatched.length, 2);
  const od1 = matched[1];
  assert.equal(od1[0], 'OD1');
  assert.equal(od1[2], 'ABC Traders Pvt. Ltd.');
  assert.equal(od1[3], 'abc traders pvt ltd');
  assert.equal(od1[5], '1,234.50', 'value exactly as in file A');
  assert.equal(od1[8], '01-Mar-2026', 'date exactly as in file A');
  assert.equal(od1[10], '0', 'same day, A - B = 0');
  assert.equal(od1[11], 'Matched');
  assert.equal(mismatched[1][0], 'OD2');
  assert.equal(mismatched[1][11], 'Mismatched');
  assert.ok(Number(mismatched[1][4]) < 50);
  // No stray symbols anywhere.
  for (const line of [...matched, ...mismatched]) for (const v of line) {
    if (v !== null) assert.doesNotMatch(String(v), /[\u2014\u2192\u00b7\u2026\uFFFD]/, `clean value: ${v}`);
  }
  assert.equal(back.Sheets.Matched.F2.t, 'n', 'amount stays a number in Excel');
  assert.equal(back.Sheets.Matched.F2.z, '#,##0.00', 'with the original number format');
});

test('Only in File A / B sheets keep the exact layout of each file', () => {
  const a = parseWorkbook(ordersBuf(), {});
  const b = parseWorkbook(formattedWorkbook(
    [
      ['OD1', new Date(Date.UTC(2026, 2, 1)), 'abc traders pvt ltd', 1234.5],
      ['OD9', new Date(Date.UTC(2026, 2, 9)), 'Ghost Party', 10],
    ],
    ['Voucher Ref', 'Voucher Date', 'Party', 'Amount'], { B3: 'dd/mm/yyyy' }, 'Tally',
  ), {});
  const run = reconcile({ rowsA: a.rows, rowsB: b.rows, headersA: a.headers, headersB: b.headers, displayA: a.display, displayB: b.display, formatsA: a.formats, formatsB: b.formats, settings });
  const all = buildXlsxWorkbook({ run, rowsA: a.rows, rowsB: b.rows, tab: 'all' });
  assert.equal(all.rows, 4, '1 matched + 2 only in A + 1 only in B');
  const matched = buildXlsxWorkbook({ run, rowsA: a.rows, rowsB: b.rows, tab: 'matched' });
  assert.deepEqual(matched.workbook.SheetNames, ['Matched']);
  const back = XLSX.read(writeXlsxBuffer(all.workbook), { type: 'buffer', cellDates: true, cellNF: true });
  const onlyA = XLSX.utils.sheet_to_json(back.Sheets['Only in File A'], { header: 1, raw: false, defval: null });
  const onlyB = XLSX.utils.sheet_to_json(back.Sheets['Only in File B'], { header: 1, raw: false, defval: null });
  assert.deepEqual(onlyA[0], ['Order ID', 'Order Date', 'Customer', 'Order Amount'], 'file A headers as-is');
  assert.deepEqual(onlyA[1], ['OD2', '02/03/2026', 'Mumbai Steel & Alloys', '900']);
  assert.deepEqual(onlyB[0], ['Voucher Ref', 'Voucher Date', 'Party', 'Amount'], 'file B headers as-is');
  assert.deepEqual(onlyB[1], ['OD9', '09/03/2026', 'Ghost Party', '10']);

  // All Data: every result in one sheet, Result says which one.
  const allData = XLSX.utils.sheet_to_json(back.Sheets['All Data'], { header: 1, raw: false, defval: null });
  assert.equal(allData.length, 1 + 4);
  assert.deepEqual(allData.slice(1).map((r) => r[r.length - 1]), ['Matched', 'Only in File A', 'Only in File A', 'Only in File B']);
  const aOnly = allData[2];
  assert.equal(aOnly[0], 'OD2');
  assert.equal(aOnly[1], null, 'no File B Order ID');
  assert.equal(aOnly[2], 'Mumbai Steel & Alloys');
  assert.equal(aOnly[3], null, 'no File B value');
  assert.equal(aOnly[4], null, 'no similarity when one side is missing');
  const bOnly = allData[4];
  assert.equal(bOnly[0], null, 'no File A Order ID');
  assert.equal(bOnly[1], 'OD9');
  assert.equal(bOnly[3], 'Ghost Party');
  assert.equal(bOnly[9], '09/03/2026');
});

test('CSV has a UTF-8 BOM, the same columns and no stray symbols', async () => {
  const { a, b, run } = runFormatted();
  const chunks = [];
  const out = { write: (s) => chunks.push(s) };
  writeCsv(out, { run, rowsA: a.rows, rowsB: b.rows }, 'breaks');
  const text = chunks.join('');
  assert.equal(text.charCodeAt(0), 0xfeff);
  const lines = text.slice(1).trim().split('\r\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Order ID \(File A\),Voucher Ref \(File B\),Customer \(File A\),Party \(File B\),Customer Similarity %/);
  assert.match(lines[1], /^OD2,OD2,Mumbai Steel & Alloys,Cash Sale,/);
  assert.match(lines[1], /,Mismatched$/);
  assert.doesNotMatch(text, /[\u2014\u2192\u00b7\u2026]/);
});
