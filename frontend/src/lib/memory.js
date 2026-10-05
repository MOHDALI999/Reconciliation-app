/**
 * Remembered rules.
 *
 * When someone corrects what the app detected, that correction is kept against
 * the shape of the two files — their column names — so the next upload of the
 * same report starts from their rules instead of the detected ones. Only
 * settings are stored; no row data ever goes to the browser's storage.
 */

const KEY = 'recon.rules.v1';
const MAX_ENTRIES = 12;

/** Only these fields are ever sent to the API, so only these are remembered. */
const PAIR_FIELDS = [
  'id', 'colA', 'colB', 'type', 'absTol', 'pctTol', 'dateBefore', 'dateAfter',
  'dateFormatA', 'dateFormatB', 'ignoreSign', 'caseSensitive', 'required',
];
const SETTING_FIELDS = [
  'keyA', 'keyB', 'keyRulesA', 'keyRulesB', 'filtersA', 'filtersB',
  'groupMatching', 'groupTolerance', 'dateAmountFallback', 'crIsNegative', 'currency', 'textThresholds',
];

const pick = (obj, fields) => {
  const out = {};
  for (const f of fields) if (obj?.[f] !== undefined) out[f] = obj[f];
  return out;
};

/** Settings trimmed to what the run schema accepts. */
export function cleanSettings(settings) {
  const out = pick(settings, SETTING_FIELDS);
  out.pairs = (settings?.pairs || [])
    .filter((p) => p.colA && p.colB)
    .map((p) => pick(p, PAIR_FIELDS));
  return out;
}

/** A stable name for "these two files' shape", independent of row order. */
export function fingerprint(fileA, fileB) {
  const side = (f) => (f?.headers || []).map((h) => String(h).trim().toLowerCase()).sort().join('|');
  if (!fileA || !fileB) return '';
  return `${side(fileA)}##${side(fileB)}`;
}

function readAll() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; }
  catch { return {}; }
}

function writeAll(all) {
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* storage full or blocked */ }
}

/** The rules this user saved for files of this shape, or null. */
export function recallRules(fp) {
  if (!fp) return null;
  const entry = readAll()[fp];
  return entry?.settings ? { settings: entry.settings, savedAt: entry.savedAt } : null;
}

export function rememberRules(fp, settings) {
  if (!fp) return;
  const all = readAll();
  all[fp] = { settings: cleanSettings(settings), savedAt: Date.now() };
  // Keep the newest handful so storage cannot grow without bound.
  const entries = Object.entries(all).sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0)).slice(0, MAX_ENTRIES);
  writeAll(Object.fromEntries(entries));
}

export function forgetRules(fp) {
  if (!fp) return;
  const all = readAll();
  delete all[fp];
  writeAll(all);
}
