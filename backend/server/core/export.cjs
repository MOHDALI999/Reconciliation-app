'use strict';
/**
 * Reconciliation export (Excel and CSV).
 *
 * Four results, and only the columns each one needs:
 *
 *   Matched / Mismatched  — Order ID (File A), Order ID (File B), then for
 *                           every field the user compared:
 *                             text   -> File A value, File B value, Similarity %
 *                             date   -> File A date,  File B date,  Diff (A - B)
 *                             amount -> File A value, File B value, Diff (A - B)
 *                           and finally Result.
 *   Only in File A        — the File A row exactly as it is in File A
 *                           (same columns, same order, same values/formats).
 *   Only in File B        — the File B row exactly as it is in File B.
 *   All Data              — all four results in one sheet with the Matched /
 *                           Mismatched layout; Result says which one each row is.
 *                           Only-in-A rows leave the File B cells empty and
 *                           only-in-B rows leave the File A cells empty.
 *
 * No "Row", "Side", reason or technical columns, and no decorative symbols
 * (em dash, arrows, dots, currency re-formatting) are ever written — every
 * value is the value that is in the file.
 */

const XLSX = require('xlsx');
const { buildRow, entriesForTab } = require('./engine.cjs');
const { shownValue } = require('./workbook.cjs');

/** A whole workbook is built in memory, so very large runs go to CSV instead. */
const XLSX_MAX_ROWS = 250_000;

const SHEETS = [
  { tab: 'allData', name: 'All Data', kind: 'pair' },
  { tab: 'matched', name: 'Matched', kind: 'pair' },
  { tab: 'breaks', name: 'Mismatched', kind: 'pair' },
  { tab: 'onlyA', name: 'Only in File A', kind: 'fileA' },
  { tab: 'onlyB', name: 'Only in File B', kind: 'fileB' },
];

const kindOfTab = (tab) => SHEETS.find((s) => s.tab === tab)?.kind || 'pair';

/* ------------------------------------------------------------------ columns */

/** The compared fields, minus the Order ID itself (it already has its own columns). */
function comparedPairs(run) {
  return (run.pairs || []).filter((p) => !(p.colA === run.keyA && p.colB === run.keyB));
}

const isTextPair = (p) => p.type === 'text' || p.type === 'identifier';

/** Header row + a per-column descriptor for the Matched / Mismatched layout. */
function pairLayout(run) {
  const cols = [
    { h: `${run.keyA} (File A)`, get: 'keyA' },
    { h: `${run.keyB} (File B)`, get: 'keyB' },
  ];
  for (const p of comparedPairs(run)) {
    cols.push({ h: `${p.colA} (File A)`, get: 'valueA', pair: p });
    cols.push({ h: `${p.colB} (File B)`, get: 'valueB', pair: p });
    if (isTextPair(p)) cols.push({ h: `${p.colA} Similarity %`, get: 'similarity', pair: p });
    else if (p.type === 'date') cols.push({ h: `${p.colA} Diff (A - B) days`, get: 'dateDiff', pair: p });
    else if (p.type === 'amount') cols.push({ h: `${p.colA} Diff (A - B)`, get: 'amountDiff', pair: p });
  }
  cols.push({ h: 'Result', get: 'result' });
  // Header names must be unique for Excel filters and CSV readers.
  const seen = new Map();
  for (const c of cols) {
    const n = seen.get(c.h) || 0;
    seen.set(c.h, n + 1);
    if (n) c.h = `${c.h} ${n + 1}`;
  }
  return cols;
}

/* ------------------------------------------------------------ cell builders */

/**
 * Write one source cell back the way the spreadsheet had it: numbers stay
 * numbers and dates stay dates, each with the original number format, so Excel
 * shows the same text the user saw. Strings are written as strings (a leading
 * "=" is stored as text, never as a formula).
 */
function sourceCell(raw, shown, format) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { t: 's', v: shown ?? String(raw) };
    return format ? { t: 'n', v: raw, z: format } : { t: 'n', v: raw };
  }
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return { t: 's', v: shown ?? '' };
    return { t: 'd', v: raw, z: format || 'dd/mm/yyyy' };
  }
  if (typeof raw === 'boolean') return { t: 'b', v: raw };
  return { t: 's', v: shown ?? String(raw) };
}

const textCell = (v) => (v === null || v === undefined || v === '' ? null : { t: 's', v: String(v) });
const numCell = (v, z) => (typeof v === 'number' && Number.isFinite(v) ? (z ? { t: 'n', v, z } : { t: 'n', v }) : null);

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * The computed values of one pair-layout row, as plain values:
 *  - `value(col)` returns { raw, shown, format } for source cells
 *  - numbers for similarity / diffs, string for the result.
 */
function pairRowValues(ctx, row, aIndex, bIndex, cols) {
  const { run, rowsA, rowsB } = ctx;
  const { displayA, displayB, formatsA, formatsB } = run.internal;
  const src = (rows, display, formats, i, col) => {
    if (i === null || i === undefined || i < 0 || !rows[i]) return null;
    return { raw: rows[i][col], shown: shownValue(rows, display, i, col), format: formats?.[i]?.[col] };
  };
  const oneSide = row.result === 'Only in File A' || row.result === 'Only in File B';
  return cols.map((c) => {
    const cell = c.pair && !oneSide ? row.cells.find((x) => x.pairId === c.pair.id) : null;
    switch (c.get) {
      case 'keyA': return { src: src(rowsA, displayA, formatsA, aIndex, run.keyA) };
      case 'keyB': return { src: src(rowsB, displayB, formatsB, bIndex, run.keyB) };
      case 'valueA': return { src: src(rowsA, displayA, formatsA, aIndex, c.pair.colA) };
      case 'valueB': return { src: src(rowsB, displayB, formatsB, bIndex, c.pair.colB) };
      case 'similarity': return { num: typeof cell?.similarity === 'number' ? round2(cell.similarity) : null };
      case 'dateDiff': return { num: typeof cell?.diffDays === 'number' ? cell.diffDays : null };
      case 'amountDiff': return { num: typeof cell?.diffMinor === 'number' ? cell.diffMinor / 100 : null };
      case 'result': return { text: row.result };
      default: return {};
    }
  });
}

/* --------------------------------------------------------------- iteration */

/** Visit every row of one result in order ("allData" = all four results). */
function forEachRow(ctx, tab, fn) {
  const { run, rowsA, rowsB } = ctx;
  const list = entriesForTab(run, tab);
  const { bIndex } = run.index;
  for (let i = 0; i < list.length; i++) {
    const { slot, tab: t } = list.at(i);
    if (t === 'onlyB') {
      fn({ aIndex: null, bIndex: slot, row: tab === 'allData' ? buildRow(run, rowsA, rowsB, slot, 'onlyB') : null });
    } else if (t === 'onlyA') {
      fn({ aIndex: slot, bIndex: null, row: tab === 'allData' ? buildRow(run, rowsA, rowsB, slot, 'onlyA') : null });
    } else {
      fn({ aIndex: slot, bIndex: bIndex[slot] >= 0 ? bIndex[slot] : null, row: buildRow(run, rowsA, rowsB, slot, t) });
    }
  }
  return list.length;
}

/* -------------------------------------------------------------------- XLSX */

function pushRow(sheet, r, cells) {
  for (let c = 0; c < cells.length; c++) {
    const cell = cells[c];
    if (cell === null || cell === undefined) continue;
    sheet[XLSX.utils.encode_cell({ r, c })] = cell;
  }
}

function finish(sheet, rows, headers) {
  const cols = Math.max(1, headers.length);
  sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows - 1), c: cols - 1 } });
  sheet['!cols'] = headers.map((h) => ({ wch: Math.min(40, Math.max(12, String(h).length + 2)) }));
  if (rows > 1) sheet['!autofilter'] = { ref: sheet['!ref'] };
  return sheet;
}

function buildSheet(ctx, def) {
  const { run, rowsA, rowsB } = ctx;
  const sheet = {};
  let r = 1;
  if (def.kind === 'fileA' || def.kind === 'fileB') {
    const isA = def.kind === 'fileA';
    const headers = isA ? run.headersA : run.headersB;
    const rows = isA ? rowsA : rowsB;
    const display = isA ? run.internal.displayA : run.internal.displayB;
    const formats = isA ? run.internal.formatsA : run.internal.formatsB;
    pushRow(sheet, 0, headers.map(textCell));
    forEachRow(ctx, def.tab, ({ aIndex, bIndex }) => {
      const i = isA ? aIndex : bIndex;
      pushRow(sheet, r++, headers.map((h) => sourceCell(rows[i]?.[h], display?.[i]?.[h], formats?.[i]?.[h])));
    });
    return finish(sheet, r, headers);
  }
  const cols = pairLayout(run);
  const headers = cols.map((c) => c.h);
  pushRow(sheet, 0, headers.map(textCell));
  forEachRow(ctx, def.tab, ({ aIndex, bIndex, row }) => {
    const vals = pairRowValues(ctx, row, aIndex, bIndex, cols);
    pushRow(sheet, r++, vals.map((v, ci) => {
      if (v.src) return sourceCell(v.src.raw, v.src.shown, v.src.format);
      if (v.num !== undefined) return numCell(v.num, cols[ci].get === 'amountDiff' ? '#,##0.00' : cols[ci].get === 'similarity' ? '0.00' : undefined);
      return textCell(v.text);
    }));
  });
  return finish(sheet, r, headers);
}

/**
 * Build the workbook. `tab = 'all'` writes the four result sheets; any single
 * result tab writes just that sheet.
 */
function buildXlsxWorkbook({ run, rowsA, rowsB, tab = 'all' }) {
  const ctx = { run, rowsA, rowsB };
  const defs = tab === 'all' ? SHEETS : SHEETS.filter((s) => s.tab === tab);
  if (!defs.length) throw new Error(`Unknown result "${tab}".`);
  const total = defs.reduce((t, d) => t + entriesForTab(run, d.tab).length, 0);
  if (total > XLSX_MAX_ROWS) {
    throw new Error(`This download has ${total.toLocaleString('en-IN')} rows. Excel download is limited to ${XLSX_MAX_ROWS.toLocaleString('en-IN')} rows; use the CSV download for each result instead.`);
  }
  const wb = XLSX.utils.book_new();
  for (const def of defs) XLSX.utils.book_append_sheet(wb, buildSheet(ctx, def), def.name);
  const rows = tab === 'all' ? entriesForTab(run, 'allData').length : total;
  return { workbook: wb, rows };
}

function writeXlsxBuffer(wb) {
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true, cellDates: true });
}

/* --------------------------------------------------------------------- CSV */

// Formula-injection guard for text only: a real number such as -1 or -250.00
// is written as-is, never with a stray apostrophe in front of it.
const NUMERIC = /^-?[\d,]*\.?\d+$/;
const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !NUMERIC.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * CSV of one result. Written with a UTF-8 byte-order mark so Excel reads
 * names such as "Café" or "₹" correctly instead of showing garbage symbols.
 */
function writeCsv(out, { run, rowsA, rowsB }, tab) {
  const ctx = { run, rowsA, rowsB };
  out.write('\uFEFF');
  const kind = kindOfTab(tab);
  let written = 0;
  if (kind === 'fileA' || kind === 'fileB') {
    const isA = kind === 'fileA';
    const headers = isA ? run.headersA : run.headersB;
    const rows = isA ? rowsA : rowsB;
    const display = isA ? run.internal.displayA : run.internal.displayB;
    out.write(`${headers.map(csvCell).join(',')}\r\n`);
    forEachRow(ctx, tab, ({ aIndex, bIndex }) => {
      const i = isA ? aIndex : bIndex;
      out.write(`${headers.map((h) => csvCell(shownValue(rows, display, i, h))).join(',')}\r\n`);
      written++;
    });
    return written;
  }
  const cols = pairLayout(run);
  out.write(`${cols.map((c) => csvCell(c.h)).join(',')}\r\n`);
  forEachRow(ctx, tab, ({ aIndex, bIndex, row }) => {
    const vals = pairRowValues(ctx, row, aIndex, bIndex, cols);
    out.write(`${vals.map((v) => csvCell(v.src ? v.src.shown : v.num !== undefined ? v.num : v.text)).join(',')}\r\n`);
    written++;
  });
  return written;
}

module.exports = {
  buildXlsxWorkbook, writeXlsxBuffer, writeCsv, sourceCell, pairLayout, comparedPairs,
  SHEETS, XLSX_MAX_ROWS,
};
