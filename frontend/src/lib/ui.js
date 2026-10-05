export const cx = (...parts) => parts.filter(Boolean).join(' ');

export const fmtInt = (n) => (Number.isFinite(n) ? n.toLocaleString('en-IN') : '—');

export const fmtBytes = (n) => {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
};

export const fmtMinor = (minor, currency = '₹') => {
  if (minor === null || minor === undefined) return '—';
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const body = `${Math.floor(abs / 100).toLocaleString('en-IN')}.${String(abs % 100).padStart(2, '0')}`;
  return `${neg ? '-' : ''}${currency}${body}`;
};

/** The text rule: similarity at or above this line is a Match, below it Not Match. */
export const DEFAULT_MATCH_LINE = 50;

/** Accept the current { match } shape and quietly replace the pre-2.1 { high, review } bands. */
export const normalizeThresholds = (t) => {
  const n = Number(t?.match);
  return { match: Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : DEFAULT_MATCH_LINE };
};

/** Two answers for text, in plain words. Reported next to the row status, never instead of it. */
export const TEXT_STATUS_LABEL = {
  MATCH: 'Match',
  MISMATCH: 'Not Match',
  EMPTY: 'Both empty',
  NOT_FOUND_IN_FILE_A: 'Not Match · missing in A',
  NOT_FOUND_IN_FILE_B: 'Not Match · missing in B',
};

export const TEXT_STATUS_TONE = {
  MATCH: 'ok',
  MISMATCH: 'bad',
  EMPTY: 'neutral',
  NOT_FOUND_IN_FILE_A: 'bad',
  NOT_FOUND_IN_FILE_B: 'bad',
};

export const STATUS_TONE = {
  MATCHED: 'text-ok bg-ok-soft',
  BREAK: 'text-bad bg-bad-soft',
  AMBIGUOUS: 'text-warn bg-warn-soft',
  ONLY_A: 'text-warn bg-warn-soft',
  ONLY_B: 'text-warn bg-warn-soft',
  EXCLUDED: 'text-ink-soft bg-canvas',
};

export const TABS = [
  { id: 'allData', label: 'All Data' },
  { id: 'matched', label: 'Matched' },
  { id: 'breaks', label: 'Mismatched' },
  { id: 'onlyA', label: 'Only in File A' },
  { id: 'onlyB', label: 'Only in File B' },
];

/** Local-only persistence: ids and settings, never row data. */
const KEY = 'reconcile.session.v2';

export function loadSession() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.schema === 2 ? parsed : null;
  } catch { return null; }
}

export function saveSession(state) {
  try { localStorage.setItem(KEY, JSON.stringify({ schema: 2, ...state })); } catch { /* quota */ }
}

export function clearSession() {
  try { localStorage.removeItem(KEY); } catch { /* noop */ }
}
