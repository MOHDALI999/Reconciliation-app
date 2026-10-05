'use strict';
/**
 * Long-lived worker that owns one reconciliation run.
 *
 * It parses both file views, holds the rows and the compact result index, then
 * answers page / detail / export requests over messages. The API process keeps
 * no row data at all, so a 500k x 500k run cannot take the server down, and the
 * event loop is never blocked by matching or export work.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const { parseWorkbook } = require('../core/workbook.cjs');
const { buildAutoPlan } = require('../core/plan.cjs');
const { reconcile, getPage, buildRow, slotsForTab, profileColumns } = require('../core/engine.cjs');
const { buildXlsxWorkbook, writeXlsxBuffer, writeCsv } = require('../core/export.cjs');

let state = null;
let cancelled = false;

const send = (msg) => parentPort.postMessage(msg);

function summarise(run) {
  return {
    engineVersion: run.engineVersion,
    timestamp: run.timestamp,
    keyA: run.keyA,
    keyB: run.keyB,
    currency: run.currency,
    counts: run.counts,
    integrity: run.integrity,
    pairs: run.pairs,
    groups: run.groups.slice(0, 200),
    headersA: run.headersA,
    headersB: run.headersB,
    // Only the resolved text thresholds travel to the client, so the review
    // screen can state which cut-offs classified the scores it is showing.
    // The resolved settings travel back so the rules screen can show exactly
    // what ran — including anything the planner decided automatically.
    settings: {
      textThresholds: run.settings.textThresholds,
      keyA: run.keyA,
      keyB: run.keyB,
      keyRulesA: run.settings.keyRulesA,
      keyRulesB: run.settings.keyRulesB,
      groupMatching: run.settings.groupMatching,
      groupTolerance: run.settings.groupTolerance,
      dateAmountFallback: run.settings.dateAmountFallback,
      crIsNegative: run.settings.crIsNegative,
      currency: run.currency,
    },
  };
}

function start() {
  const t0 = Date.now();
  send({ type: 'progress', phase: 'reading', done: 0.02 });
  const a = parseWorkbook(fs.readFileSync(workerData.fileA.path), workerData.fileA);
  send({ type: 'progress', phase: 'reading', done: 0.1 });
  const b = parseWorkbook(fs.readFileSync(workerData.fileB.path), workerData.fileB);
  // Automatic mode: the plan is derived here, from the full data, before any
  // comparison runs. Anything the user has already decided is passed in as an
  // override and wins over the detected choice.
  let settings = workerData.settings;
  let plan = null;
  if (settings.auto) {
    send({ type: 'progress', phase: 'planning', done: 0.13 });
    const profileA = profileColumns(a.rows, a.headers, a.hints);
    const profileB = profileColumns(b.rows, b.headers, b.hints);
    plan = buildAutoPlan({
      rowsA: a.rows, rowsB: b.rows, profileA, profileB,
      overrides: {
        keyA: settings.keyA, keyB: settings.keyB,
        keyRulesA: settings.keyRulesA, keyRulesB: settings.keyRulesB,
        pairs: settings.pairs,
      },
    });
    settings = {
      ...settings,
      keyA: plan.keyA, keyB: plan.keyB,
      keyRulesA: plan.keyRulesA, keyRulesB: plan.keyRulesB,
      pairs: plan.pairs,
    };
    delete settings.auto;
  }
  send({ type: 'progress', phase: 'matching', done: 0.15 });

  const run = reconcile({
    rowsA: a.rows,
    rowsB: b.rows,
    headersA: a.headers,
    headersB: b.headers,
    hintsA: a.hints,
    hintsB: b.hints,
    // What each cell showed in the spreadsheet, so the review grid and the
    // export can present the file exactly as it was.
    displayA: a.display,
    displayB: b.display,
    formatsA: a.formats,
    formatsB: b.formats,
    date1904A: a.date1904,
    date1904B: b.date1904,
    settings,
    onProgress: (p) => {
      if (cancelled) throw new Error('Run cancelled.');
      send({ type: 'progress', ...p });
    },
  });

  state = { run, rowsA: a.rows, rowsB: b.rows };
  send({
    type: 'ready',
    summary: { ...summarise(run), plan },
    stats: {
      durationMs: Date.now() - t0,
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1048576),
      rowsA: a.rows.length,
      rowsB: b.rows.length,
      fileA: { name: workerData.fileA.name, sheet: a.selectedSheet, headerRow: a.headerRowIndex, sha256: workerData.fileA.sha256 },
      fileB: { name: workerData.fileB.name, sheet: b.selectedSheet, headerRow: b.headerRowIndex, sha256: workerData.fileB.sha256 },
    },
  });
}

/* ---------------------------------------------------------------- CSV export */

/** One result per CSV: the same columns as the matching Excel sheet. */
function exportCsv({ tab }) {
  const { run, rowsA, rowsB } = state;
  const scope = ['allData', 'matched', 'breaks', 'onlyA', 'onlyB'].includes(tab) ? tab : 'allData';
  const file = path.join(os.tmpdir(), `recon-export-${Date.now()}-${scope}.csv`);
  const out = fs.createWriteStream(file, { encoding: 'utf8' });
  const rows = writeCsv(out, { run, rowsA, rowsB }, scope);
  return new Promise((resolve, reject) => {
    out.end(() => resolve({ file, rows }));
    out.on('error', reject);
  });
}

/* --------------------------------------------------------------- XLSX export */

async function exportXlsx({ tab }) {
  const { run, rowsA, rowsB } = state;
  const { workbook, rows } = buildXlsxWorkbook({
    run, rowsA, rowsB, tab,
    fileA: { name: workerData.fileA.name, sha256: workerData.fileA.sha256 },
    fileB: { name: workerData.fileB.name, sha256: workerData.fileB.sha256 },
  });
  const file = path.join(os.tmpdir(), `recon-export-${Date.now()}-${tab}.xlsx`);
  await fs.promises.writeFile(file, writeXlsxBuffer(workbook));
  return { file, rows };
}

/* ------------------------------------------------------------------ dispatch */

parentPort.on('message', async (msg) => {
  try {
    if (msg.type === 'cancel') { cancelled = true; return; }
    if (!state) return send({ type: 'error', requestId: msg.requestId, message: 'Run is not ready yet.' });

    if (msg.type === 'page') {
      const page = getPage(state.run, state.rowsA, state.rowsB, msg);
      return send({ type: 'page', requestId: msg.requestId, ...page });
    }
    if (msg.type === 'detail') {
      const slot = Number(msg.slot);
      const row = buildRow(state.run, state.rowsA, state.rowsB, slot, msg.tab);
      return send({ type: 'detail', requestId: msg.requestId, row });
    }
    if (msg.type === 'export') {
      const result = await exportCsv(msg);
      return send({ type: 'export', requestId: msg.requestId, ...result });
    }
    if (msg.type === 'export-xlsx') {
      const result = await exportXlsx(msg);
      return send({ type: 'export-xlsx', requestId: msg.requestId, ...result });
    }
    send({ type: 'error', requestId: msg.requestId, message: `Unknown request "${msg.type}".` });
  } catch (err) {
    send({ type: 'error', requestId: msg.requestId, message: err?.message || 'Worker request failed.' });
  }
});

try {
  start();
} catch (err) {
  send({ type: 'failed', message: err?.message || 'Reconciliation failed.' });
}
