'use strict';
/**
 * Spreadsheet ingestion. One pass, one copy of the data.
 * The browser only ever receives metadata + a 30-row preview.
 */

const XLSX = require('xlsx');

const MAX_ROWS = 1_200_000;
const MAX_COLS = 512;

function uniqueHeaders(headerRow) {
  const seen = new Map();
  return headerRow.map((h, i) => {
    const base = String(h ?? '').trim() || `Column ${i + 1}`;
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return n ? `${base} (${n + 1})` : base;
  });
}

function guessHeaderRow(grid) {
  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < Math.min(25, grid.length); i++) {
    const row = Array.isArray(grid[i]) ? grid[i] : [];
    let text = 0, nonText = 0;
    for (const c of row) {
      if (c === '' || c === null || c === undefined) continue;
      if (typeof c === 'number' || typeof c === 'boolean' || c instanceof Date) nonText++;
      else text++;
    }
    const score = text * 2 - nonText;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

function columnNumberFormats(sheet, headerIdx, colCount) {
  const hints = [];
  for (let c = 0; c < colCount; c++) {
    let hint = null;
    for (let r = headerIdx + 1; r <= headerIdx + 40; r++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (cell?.z) { hint = cell.z; break; }
    }
    hints.push(hint);
  }
  return hints;
}

const cellText = (v) => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
};

/**
 * One pass over the sheet's range. Produces, aligned row for row:
 *   grid    — raw values (numbers, Dates, strings), what the engine computes on
 *   shown   — the text Excel displayed for the cell (SheetJS `w`), only where it
 *             differs from String(raw), so text cells cost no extra memory
 *   formats — the cell's number format (SheetJS `z`) for those same cells, so an
 *             export can write the number back with the same format
 * Blank rows are skipped by raw value, so the three arrays never drift apart.
 */
function readGrid(sheet) {
  const ref = sheet['!ref'];
  if (!ref) return { grid: [], shown: [], formats: [], colCount: 0 };
  const range = XLSX.utils.decode_range(ref);
  const colCount = Math.min(range.e.c - range.s.c + 1, MAX_COLS);
  const grid = [];
  const shown = [];
  const formats = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const vals = new Array(colCount).fill(null);
    let texts = null;
    let fmts = null;
    let blank = true;
    for (let c = 0; c < colCount; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c: range.s.c + c })];
      if (!cell || cell.t === 'z' || cell.v === undefined || cell.v === null) continue;
      let v = cell.v;
      if (cell.t === 'e') v = cell.w ?? String(v);            // error cells keep their text
      if (typeof v === 'string' && v.trim() === '' ) { vals[c] = v; continue; }
      vals[c] = v;
      blank = false;
      if (typeof cell.w === 'string' && cell.w !== cellText(v)) {
        (texts ||= new Array(colCount).fill(null))[c] = cell.w;
        if (cell.z && cell.z !== 'General') (fmts ||= new Array(colCount).fill(null))[c] = cell.z;
      }
    }
    if (blank) continue;
    grid.push(vals);
    shown.push(texts);
    formats.push(fmts);
    if (grid.length > MAX_ROWS) break;
  }
  return { grid, shown, formats, colCount };
}

/**
 * Parse a workbook view.
 * @returns {{sheetNames, selectedSheet, headerRowIndex, guessedHeaderRow, headers,
 *            rows, display, formats, preview, totalRows, totalCols, date1904, hints}}
 *   rows[i][header]    raw value the engine computes on
 *   display[i]         null, or { [header]: text exactly as the spreadsheet showed it }
 *   formats[i]         null, or { [header]: Excel number format of that cell }
 */
function parseWorkbook(buffer, { sheetName, headerRowIndex } = {}) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellNF: true, cellText: true, raw: true, dense: false });
  if (!wb.SheetNames.length) throw new Error('This file has no sheets.');
  const selectedSheet = sheetName && wb.SheetNames.includes(sheetName) ? sheetName : wb.SheetNames[0];
  const sheet = wb.Sheets[selectedSheet];
  const { grid, shown, formats: fmtGrid, colCount } = readGrid(sheet);
  if (!grid.length) throw new Error(`Sheet "${selectedSheet}" is empty.`);
  if (grid.length > MAX_ROWS) throw new Error(`Sheet has more than ${MAX_ROWS.toLocaleString()} rows; that is the limit.`);

  const guessed = guessHeaderRow(grid);
  const headerIdx = Number.isInteger(headerRowIndex) && headerRowIndex >= 0 && headerRowIndex < grid.length ? headerRowIndex : guessed;
  const headerRow = Array.isArray(grid[headerIdx]) ? grid[headerIdx] : [];
  // Header text is what the spreadsheet showed (a numeric header like 2024 stays "2024").
  const headerTexts = headerRow.slice(0, colCount).map((h, c) => shown[headerIdx]?.[c] ?? cellText(h));
  const headers = uniqueHeaders(headerTexts.length ? headerTexts : Array.from({ length: colCount }, () => ''));

  const rows = [];
  const display = [];
  const formats = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const r = grid[i];
    if (!Array.isArray(r) || r.every((v) => v === null || v === undefined || String(v).trim() === '')) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) obj[headers[c]] = r[c] === undefined ? null : r[c];
    rows.push(obj);
    const t = shown[i];
    if (t) {
      const d = {};
      for (let c = 0; c < headers.length; c++) if (t[c] !== null && t[c] !== undefined) d[headers[c]] = t[c];
      display.push(d);
      const f = fmtGrid[i];
      if (f) {
        const fo = {};
        for (let c = 0; c < headers.length; c++) if (f[c]) fo[headers[c]] = f[c];
        formats.push(fo);
      } else formats.push(null);
    } else { display.push(null); formats.push(null); }
  }

  const preview = grid.slice(0, Math.min(grid.length, Math.max(headerIdx + 16, 30))).map((r, i) =>
    (Array.isArray(r) ? r.slice(0, colCount) : []).map((v, c) => shown[i]?.[c] ?? cellText(v)));

  const hintList = columnNumberFormats(sheet, headerIdx, headers.length);
  const hints = {};
  headers.forEach((h, i) => { if (hintList[i]) hints[h] = hintList[i]; });

  return {
    sheetNames: wb.SheetNames,
    selectedSheet,
    headerRowIndex: headerIdx,
    guessedHeaderRow: guessed,
    headers,
    rows,
    display,
    formats,
    preview,
    totalRows: rows.length,
    totalCols: headers.length,
    date1904: !!wb.Workbook?.WBProps?.date1904,
    hints,
  };
}

/** The text a cell showed in the spreadsheet: display text if captured, else the raw value as text. */
function shownValue(rows, display, i, column) {
  const d = display?.[i];
  if (d && d[column] !== undefined) return d[column];
  return cellText(rows[i]?.[column]);
}

module.exports = { parseWorkbook, guessHeaderRow, readGrid, shownValue, cellText, MAX_ROWS };
