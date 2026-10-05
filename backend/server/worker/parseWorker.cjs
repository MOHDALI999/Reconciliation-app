'use strict';
/**
 * Short-lived worker: parse one uploaded file view, return metadata,
 * a 30-row preview and a per-column profile. Row data never leaves the worker,
 * so neither the API process nor the browser holds the dataset.
 */

const fs = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');
const { parseWorkbook } = require('../core/workbook.cjs');
const { profileColumns } = require('../core/engine.cjs');

try {
  const buffer = fs.readFileSync(workerData.path);
  const parsed = parseWorkbook(buffer, {
    sheetName: workerData.sheetName,
    headerRowIndex: workerData.headerRowIndex,
  });
  const profile = profileColumns(parsed.rows, parsed.headers, parsed.hints);
  parentPort.postMessage({
    ok: true,
    view: {
      sheetNames: parsed.sheetNames,
      selectedSheet: parsed.selectedSheet,
      headerRowIndex: parsed.headerRowIndex,
      guessedHeaderRow: parsed.guessedHeaderRow,
      headers: parsed.headers,
      preview: parsed.preview,
      totalRows: parsed.totalRows,
      totalCols: parsed.totalCols,
      date1904: parsed.date1904,
      hints: parsed.hints,
      profile,
    },
  });
} catch (err) {
  parentPort.postMessage({ ok: false, message: err?.message || 'Could not read this file.' });
}
