'use strict';
/**
 * Reconciliation API.
 *
 * Shape of the system:
 *   upload  -> file saved to disk, parsed in a short-lived worker (metadata +
 *              30-row preview + column profile only)
 *   run     -> a dedicated worker owns the rows and the result index; the API
 *              process stays small and responsive
 *   review  -> pages and row detail are pulled from that worker
 *   export  -> the worker writes CSV or XLSX to a temp file, the API pipes it out
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { z } = require('zod');

const PORT = Number(process.env.PORT || 8787);
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(os.tmpdir(), 'reconcile-uploads');
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 80 * 1024 * 1024);
const FILE_TTL_MS = 6 * 60 * 60 * 1000;
const RUN_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_FILES = 20;
const MAX_RUNS = 4;
const ALLOWED_EXT = new Set(['.xlsx', '.xls', '.xlsm', '.csv', '.txt']);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.get('/', (req, res) => {
  res.send('Hello World')
})
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(cors({
  origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : true,
  credentials: false,
  methods: ['GET', 'POST', 'DELETE'],
}));
app.use(express.json({ limit: '256kb', strict: true }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}.bin`),
  }),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return cb(new Error(`Unsupported file type "${ext || 'unknown'}". Use .xlsx, .xls, .xlsm or .csv.`));
    cb(null, true);
  },
});

/* ------------------------------------------------------------------- stores */

/** fileId -> { path, name, size, sha256, view, createdAt, lastUsed } */
const files = new Map();
/** runId -> { worker, status, progress, summary, stats, error, createdAt, lastUsed, pending } */
const runs = new Map();

const touch = (entry) => { entry.lastUsed = Date.now(); return entry; };

function dropFile(id) {
  const f = files.get(id);
  if (!f) return;
  files.delete(id);
  fs.promises.unlink(f.path).catch(() => {});
}

function dropRun(id) {
  const r = runs.get(id);
  if (!r) return;
  runs.delete(id);
  try { r.worker?.terminate(); } catch { /* already gone */ }
  if (r.exportFile) fs.promises.unlink(r.exportFile).catch(() => {});
}

function evictOldest(map, dropper, max) {
  while (map.size > max) {
    let oldestId = null;
    let oldest = Infinity;
    for (const [id, entry] of map) if (entry.lastUsed < oldest) { oldest = entry.lastUsed; oldestId = id; }
    if (!oldestId) break;
    dropper(oldestId);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, f] of files) if (now - f.lastUsed > FILE_TTL_MS) dropFile(id);
  for (const [id, r] of runs) if (now - r.lastUsed > RUN_TTL_MS) dropRun(id);
}, 5 * 60_000).unref();

/* ------------------------------------------------------------------ helpers */

const workerPath = (name) => path.join(__dirname, 'worker', name);

function parseInWorker({ path: filePath, sheetName, headerRowIndex }) {
  return new Promise((resolve, reject) => {
    const w = new Worker(workerPath('parseWorker.cjs'), { workerData: { path: filePath, sheetName, headerRowIndex } });
    const timer = setTimeout(() => { w.terminate(); reject(new Error('Reading this file took too long and was stopped.')); }, 5 * 60_000);
    w.once('message', (msg) => {
      clearTimeout(timer);
      w.terminate();
      if (msg.ok) resolve(msg.view); else reject(new Error(msg.message));
    });
    w.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

let requestSeq = 0;
function askRun(run, message, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const requestId = `r${++requestSeq}`;
    const timer = setTimeout(() => { run.pending.delete(requestId); reject(new Error('The run did not respond in time.')); }, timeoutMs);
    run.pending.set(requestId, { resolve, reject, timer });
    run.worker.postMessage({ ...message, requestId });
  });
}

const clientFile = (id, f) => ({
  fileId: id,
  name: f.name,
  size: f.size,
  sha256: f.sha256.slice(0, 16),
  sheetNames: f.view.sheetNames,
  selectedSheet: f.view.selectedSheet,
  headerRowIndex: f.view.headerRowIndex,
  guessedHeaderRow: f.view.guessedHeaderRow,
  headers: f.view.headers,
  preview: f.view.preview,
  totalRows: f.view.totalRows,
  totalCols: f.view.totalCols,
  date1904: f.view.date1904,
  profile: f.view.profile,
});

const fail = (res, code, message) => res.status(code).json({ message });

/* ------------------------------------------------------------------- schemas */

const keyRules = z.object({
  caseFold: z.boolean().optional(),
  extract: z.string().max(200).optional(),
  prefix: z.string().max(64).optional(),
  stripSeparators: z.boolean().optional(),
  dropLeadingZeros: z.boolean().optional(),
  collapseTrailingZeros: z.boolean().optional(),
}).strict().optional();

const pairSchema = z.object({
  id: z.string().max(40).optional(),
  colA: z.string().min(1).max(200),
  colB: z.string().min(1).max(200),
  type: z.enum(['auto', 'amount', 'date', 'identifier', 'text']).optional(),
  absTol: z.number().min(0).max(1e9).optional(),
  pctTol: z.number().min(0).max(100).optional(),
  dateBefore: z.number().int().min(0).max(3650).optional(),
  dateAfter: z.number().int().min(0).max(3650).optional(),
  dateFormatA: z.enum(['auto', 'DMY', 'MDY', 'YMD', 'SERIAL']).optional(),
  dateFormatB: z.enum(['auto', 'DMY', 'MDY', 'YMD', 'SERIAL']).optional(),
  ignoreSign: z.boolean().optional(),
  caseSensitive: z.boolean().optional(),
  required: z.boolean().optional(),
}).strict();

const filterSchema = z.object({
  column: z.string().max(200),
  include: z.array(z.string().max(300)).max(1000).optional(),
  exclude: z.array(z.string().max(300)).max(1000).optional(),
}).strict();

const runSchema = z.object({
  fileIdA: z.string().uuid(),
  fileIdB: z.string().uuid(),
  settings: z.object({
    // Automatic mode: the worker derives the key, its clean-up rules and the
    // comparison rules from the data. Anything supplied here still wins.
    auto: z.boolean().optional(),
    keyA: z.string().min(1).max(200).optional(),
    keyB: z.string().min(1).max(200).optional(),
    keyRulesA: keyRules,
    keyRulesB: keyRules,
    pairs: z.array(pairSchema).max(40).optional(),
    filtersA: z.array(filterSchema).max(20).optional(),
    filtersB: z.array(filterSchema).max(20).optional(),
    groupMatching: z.boolean().optional(),
    groupTolerance: z.number().min(0).max(1e6).optional(),
    dateAmountFallback: z.boolean().optional(),
    crIsNegative: z.boolean().optional(),
    currency: z.string().max(4).optional(),
    // Text match line, in percent: similarity >= match -> Match, else Not
    // Match. Default 50. `high` / `review` are the pre-2.1 shape; they are
    // accepted so old saved rules still validate, and ignored.
    textThresholds: z.object({
      match: z.number().min(0).max(100).optional(),
      high: z.number().min(0).max(100).optional(),
      review: z.number().min(0).max(100).optional(),
    }).strict().optional(),
  }).strict(),
}).strict();

/* -------------------------------------------------------------------- routes */

app.get('/api/health', (_req, res) => res.json({
  ok: true,
  service: 'reconcile-api',
  version: '2.1.0',
  files: files.size,
  runs: runs.size,
  heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1048576),
}));

app.post('/api/files', upload.single('file'), async (req, res) => {
  if (!req.file) return fail(res, 400, 'Choose a file to upload.');
  try {
    const buf = await fs.promises.readFile(req.file.path);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const view = await parseInWorker({ path: req.file.path });
    const id = crypto.randomUUID();
    files.set(id, touch({
      path: req.file.path,
      name: req.file.originalname,
      size: req.file.size,
      sha256,
      view,
      createdAt: Date.now(),
    }));
    evictOldest(files, dropFile, MAX_FILES);
    res.json(clientFile(id, files.get(id)));
  } catch (err) {
    fs.promises.unlink(req.file.path).catch(() => {});
    fail(res, 400, err?.message || 'Could not read this file.');
  }
});

/** Change sheet or header row. The new view becomes canonical for later runs. */
app.post('/api/files/:fileId/view', async (req, res) => {
  const f = files.get(req.params.fileId);
  if (!f) return fail(res, 410, 'This upload has expired. Please upload the file again.');
  const parsed = z.object({
    sheetName: z.string().max(200).optional(),
    headerRowIndex: z.number().int().min(0).max(1000).optional(),
  }).strict().safeParse(req.body || {});
  if (!parsed.success) return fail(res, 400, 'Invalid sheet or header row.');
  try {
    const view = await parseInWorker({ path: f.path, ...parsed.data });
    f.view = view;             // canonical — a run always uses what you see
    touch(f);
    res.json(clientFile(req.params.fileId, f));
  } catch (err) {
    fail(res, 400, err?.message || 'Could not read that sheet.');
  }
});

app.delete('/api/files/:fileId', (req, res) => { dropFile(req.params.fileId); res.json({ ok: true }); });

app.post('/api/runs', (req, res) => {
  const parsed = runSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return fail(res, 400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const { fileIdA, fileIdB, settings } = parsed.data;
  const a = files.get(fileIdA);
  const b = files.get(fileIdB);
  if (!a || !b) return fail(res, 410, 'One of the uploads has expired. Please upload both files again.');
  if (!settings.auto && (!settings.keyA || !settings.keyB)) {
    return fail(res, 400, 'Pick a key column for both files, or run in automatic mode.');
  }
  if (settings.keyA && !a.view.headers.includes(settings.keyA)) return fail(res, 400, `"${settings.keyA}" is not a column in ${a.name}.`);
  if (settings.keyB && !b.view.headers.includes(settings.keyB)) return fail(res, 400, `"${settings.keyB}" is not a column in ${b.name}.`);

  const runId = crypto.randomUUID();
  const worker = new Worker(workerPath('runWorker.cjs'), {
    workerData: {
      fileA: { path: a.path, name: a.name, sha256: a.sha256.slice(0, 16), sheetName: a.view.selectedSheet, headerRowIndex: a.view.headerRowIndex },
      fileB: { path: b.path, name: b.name, sha256: b.sha256.slice(0, 16), sheetName: b.view.selectedSheet, headerRowIndex: b.view.headerRowIndex },
      settings,
    },
    resourceLimits: { maxOldGenerationSizeMb: 4096 },
  });

  const run = {
    worker,
    status: 'running',
    progress: { phase: 'starting', done: 0 },
    summary: null,
    stats: null,
    error: null,
    createdAt: Date.now(),
    lastUsed: Date.now(),
    pending: new Map(),
    listeners: new Set(),
  };
  runs.set(runId, run);
  touch(a); touch(b);

  const notify = () => {
    for (const write of run.listeners) write();
  };

  worker.on('message', (msg) => {
    const pending = msg.requestId ? run.pending.get(msg.requestId) : null;
    if (pending) {
      clearTimeout(pending.timer);
      run.pending.delete(msg.requestId);
      if (msg.type === 'error') pending.reject(new Error(msg.message)); else pending.resolve(msg);
      return;
    }
    if (msg.type === 'progress') { run.progress = { phase: msg.phase, done: msg.done }; notify(); return; }
    if (msg.type === 'ready') {
      run.status = 'ready';
      run.summary = msg.summary;
      run.stats = msg.stats;
      run.progress = { phase: 'done', done: 1 };
      notify();
      return;
    }
    if (msg.type === 'failed') { run.status = 'failed'; run.error = msg.message; notify(); }
  });
  worker.on('error', (err) => { run.status = 'failed'; run.error = err?.message || 'Run crashed.'; notify(); });
  worker.on('exit', () => { if (run.status === 'running') { run.status = 'failed'; run.error = run.error || 'Run stopped unexpectedly.'; notify(); } });

  evictOldest(runs, dropRun, MAX_RUNS);
  res.status(202).json({ runId, status: run.status });
});

const runState = (runId, run) => ({
  runId,
  status: run.status,
  progress: run.progress,
  error: run.error,
  summary: run.summary,
  stats: run.stats,
});

app.get('/api/runs/:runId', (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run) return fail(res, 410, 'This run has expired. Please run the reconciliation again.');
  touch(run);
  res.json(runState(req.params.runId, run));
});

/** Server-sent progress, so the UI has a real progress bar instead of a spinner. */
app.get('/api/runs/:runId/events', (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run) return fail(res, 410, 'This run has expired.');
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders?.();
  const write = () => {
    res.write(`data: ${JSON.stringify(runState(req.params.runId, run))}\n\n`);
    if (run.status !== 'running') res.end();
  };
  run.listeners.add(write);
  write();
  req.on('close', () => run.listeners.delete(write));
});

app.delete('/api/runs/:runId', (req, res) => {
  const run = runs.get(req.params.runId);
  if (run) { try { run.worker.postMessage({ type: 'cancel' }); } catch { /* noop */ } dropRun(req.params.runId); }
  res.json({ ok: true });
});

app.get('/api/runs/:runId/rows', async (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run) return fail(res, 410, 'This run has expired. Please run the reconciliation again.');
  if (run.status !== 'ready') return fail(res, 409, run.error || 'The run is still working.');
  touch(run);
  try {
    const page = await askRun(run, {
      type: 'page',
      tab: String(req.query.tab || 'exceptions'),
      offset: Math.max(0, Number.parseInt(req.query.offset, 10) || 0),
      limit: Math.min(400, Math.max(1, Number.parseInt(req.query.limit, 10) || 100)),
      search: String(req.query.search || '').slice(0, 200),
    });
    res.json({ rows: page.rows, total: page.total });
  } catch (err) {
    fail(res, 500, err?.message || 'Could not load rows.');
  }
});

app.get('/api/runs/:runId/rows/:slot', async (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run || run.status !== 'ready') return fail(res, 410, 'This run has expired.');
  touch(run);
  try {
    const out = await askRun(run, { type: 'detail', slot: Number(req.params.slot), tab: String(req.query.tab || 'exceptions') });
    res.json(out.row);
  } catch (err) {
    fail(res, 500, err?.message || 'Could not load this row.');
  }
});

const FILE_NAME = { all: 'all-results', allData: 'all-data', matched: 'matched', breaks: 'mismatched', onlyA: 'only-in-file-A', onlyB: 'only-in-file-B' };

app.get('/api/runs/:runId/export', async (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run || run.status !== 'ready') return fail(res, 410, 'This run has expired. Please run the reconciliation again.');
  touch(run);
  const tab = String(req.query.tab || 'all');
  try {
    const out = await askRun(run, {
      type: 'export',
      tab,
      includeSourceColumns: req.query.full === '1',
    }, 15 * 60_000);
    run.exportFile = out.file;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reconciliation-${FILE_NAME[tab] || tab}-${new Date().toISOString().slice(0, 10)}.csv"`);
    const stream = fs.createReadStream(out.file);
    stream.pipe(res);
    stream.on('close', () => fs.promises.unlink(out.file).catch(() => {}));
  } catch (err) {
    fail(res, 500, err?.message || 'Could not build the export.');
  }
});

/**
 * Excel download. Sheet 1 = the data exactly as in the files + Match / Not
 * Match columns; sheet 2 = per-row details; sheet 3 = run info.
 */
app.get('/api/runs/:runId/export.xlsx', async (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run || run.status !== 'ready') return fail(res, 410, 'This run has expired. Please run the reconciliation again.');
  touch(run);
  const tab = String(req.query.tab || 'all');
  try {
    const out = await askRun(run, { type: 'export-xlsx', tab }, 15 * 60_000);
    run.exportFile = out.file;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="reconciliation-${FILE_NAME[tab] || tab}-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    const stream = fs.createReadStream(out.file);
    stream.pipe(res);
    stream.on('close', () => fs.promises.unlink(out.file).catch(() => {}));
  } catch (err) {
    fail(res, 500, err?.message || 'Could not build the Excel export.');
  }
});

app.use((err, _req, res, _next) => {
  const status = err?.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  res.status(status).json({ message: err?.message || 'Request failed.' });
});

if (require.main === module) {
  const server = app.listen(PORT, () => console.log(`reconcile-api on http://localhost:${PORT}`));
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\nPort ${PORT} is already in use. The API is probably already running in another terminal.`);
      console.error('Close that terminal (or press Ctrl+C in it), or stop the old process:');
      console.error(`  Windows:     netstat -ano | findstr :${PORT}   then   taskkill /PID <number> /F`);
      console.error(`  Mac / Linux: lsof -ti :${PORT} | xargs kill`);
      console.error('Then run this command again.\n');
      process.exit(1);
    }
    throw err;
  });
}

module.exports = app;
