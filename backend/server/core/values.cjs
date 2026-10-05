'use strict';
/**
 * Value primitives: money, keys, dates.
 * Every comparison in the engine goes through this file, so semantics are
 * defined exactly once. Money is always integer minor units (paise/cents).
 */

const T = require('./text.cjs');

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const pad2 = (n) => String(n).padStart(2, '0');
const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';

/* ------------------------------------------------------------------ money */

/**
 * Parse a money-ish value into integer minor units.
 * Handles: currency symbols, thousand separators, EU decimal comma,
 * parentheses negatives, trailing minus, Tally Dr/Cr suffixes, percent-free
 * numerics. Returns null when the value is not numeric.
 */
function parseMoneyMinor(value, opts = {}) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Math.round(value * 100);
  }
  let s = String(value).trim();
  if (!s) return null;

  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1).trim(); }

  // Tally / accounting Dr-Cr suffix. Cr is negative unless the caller says
  // the file uses unsigned magnitudes.
  const drcr = s.match(/\b(dr|cr)\b\.?$/i);
  if (drcr) {
    s = s.slice(0, drcr.index).trim();
    if (drcr[1].toLowerCase() === 'cr' && opts.crIsNegative !== false) sign = -sign;
  }

  s = s.replace(/(?:₹|rs\.?|inr|usd|eur|gbp|\$|€|£)/gi, '').replace(/\s/g, '');
  if (s.endsWith('-')) { sign = -sign; s = s.slice(0, -1); }
  if (s.startsWith('-')) { sign = -sign; s = s.slice(1); }
  if (s.startsWith('+')) s = s.slice(1);
  if (!s) return null;

  // Decimal separator. "1.234,56" is EU, "1,234.56" is IN/US. When only one
  // separator type is present, a 3-digit group is a thousand separator.
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(/,/g, '.');
    else s = s.replace(/,/g, '');
  } else if (hasComma) {
    // 1,500 / 12,34,567 -> thousands.  1,5 / 1,55 -> decimal comma.
    s = /,\d{3}$/.test(s) ? s.replace(/,/g, '') : s.replace(/,/g, '.');
  } else if (hasDot) {
    // 1.234.567 -> EU thousands.  1.5 / 1.500 -> decimal point.
    s = /^\d{1,3}(?:\.\d{3}){2,}$/.test(s) ? s.replace(/\./g, '') : s;
  }
  if ((s.match(/\./g) || []).length > 1) return null;

  if (!/^\d*(?:\.\d*)?$/.test(s)) return null;
  const [intPart = '0', fracPart = ''] = s.split('.');
  const frac = (fracPart + '00').slice(0, 2);
  const rounded = fracPart.length > 2 && Number(fracPart[2]) >= 5 ? 1 : 0;
  const minor = Number(intPart || '0') * 100 + Number(frac) + rounded;
  if (!Number.isFinite(minor)) return null;
  return sign * minor;
}

const isNumericValue = (v) => parseMoneyMinor(v) !== null && !/[a-z]{2,}/i.test(String(v ?? '').replace(/\b(dr|cr)\b\.?/i, '').replace(/(?:rs|inr|usd|eur|gbp)/gi, ''));

const formatMinor = (minor, currency = '₹') => {
  if (minor === null || minor === undefined) return '';
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const body = `${Math.floor(abs / 100).toLocaleString('en-IN')}.${pad2(abs % 100)}`;
  return `${neg ? '-' : ''}${currency}${body}`;
};

/**
 * Compare two money values in minor units.
 * Tolerance is absolute (major units) and/or percentage of the larger side.
 */
function compareMoney(a, b, { absTol = 0, pctTol = 0, ignoreSign = false, crIsNegative = true } = {}) {
  let x = parseMoneyMinor(a, { crIsNegative });
  let y = parseMoneyMinor(b, { crIsNegative });
  if (x === null || y === null) return { ok: false, status: 'NOT_NUMERIC', diffMinor: null, a: x, b: y };
  if (ignoreSign) { x = Math.abs(x); y = Math.abs(y); }
  const diff = x - y;
  const tol = Math.max(
    Math.round((Number(absTol) || 0) * 100),
    Math.round((Math.max(Math.abs(x), Math.abs(y)) * (Number(pctTol) || 0)) / 100),
  );
  const ok = Math.abs(diff) <= tol;
  return {
    ok,
    status: diff === 0 ? 'EXACT' : ok ? 'WITHIN_TOLERANCE' : 'OUT_OF_TOLERANCE',
    diffMinor: diff,
    a: x,
    b: y,
    tolMinor: tol,
  };
}

/* -------------------------------------------------------------------- keys */

const regexCache = new Map();
function compileRegex(pattern) {
  if (!pattern) return null;
  if (String(pattern).length > 200) throw new Error('Extract pattern is too long (max 200 characters).');
  if (regexCache.has(pattern)) return regexCache.get(pattern);
  const re = new RegExp(pattern, 'i'); // throws on invalid — surfaced to the user
  if (regexCache.size > 200) regexCache.clear();
  regexCache.set(pattern, re);
  return re;
}

const DEFAULT_KEY_RULES = {
  caseFold: true,
  extract: '',
  prefix: '',
  stripSeparators: true,
  dropLeadingZeros: false,
  collapseTrailingZeros: true,
};

/**
 * Explicit, ordered key normalisation. Returns the normalised key plus the
 * steps that were applied, so a match can always be explained.
 */
function normalizeKey(value, rules = {}) {
  const r = { ...DEFAULT_KEY_RULES, ...rules };
  const steps = [];
  let s = String(value ?? '').trim();
  if (!s) return { key: '', steps, empty: true };

  if (r.extract) {
    const re = compileRegex(r.extract);
    const m = s.match(re);
    if (m) { s = (m[1] ?? m[0]).trim(); steps.push('extract'); }
  }
  if (r.prefix) {
    const p = String(r.prefix).trim();
    if (p && s.toUpperCase().startsWith(p.toUpperCase())) { s = s.slice(p.length).trim(); steps.push('strip-prefix'); }
  }
  if (r.caseFold) { const l = s.toLowerCase(); if (l !== s) steps.push('case-fold'); s = l; }
  if (r.collapseTrailingZeros && /^\d+\.0+$/.test(s)) { s = s.replace(/\.0+$/, ''); steps.push('collapse-.00'); }
  if (r.stripSeparators) {
    const stripped = s.replace(/[^\p{L}\p{N}]/gu, '');
    if (stripped !== s) steps.push('strip-separators');
    s = stripped;
  }
  if (r.dropLeadingZeros && /^0+\d/.test(s)) { s = s.replace(/^0+/, ''); steps.push('drop-leading-zeros'); }

  return { key: s, steps, empty: s === '' };
}

const SUMMARY_RE = /^(?:grand\s*total|sub\s*total|subtotal|totals?)\b[:\s]*$/i;
/** A row is a spreadsheet summary row only if the key literally reads like one. */
const isSummaryKey = (v) => SUMMARY_RE.test(String(v ?? '').trim());

/* ------------------------------------------------------------------- dates */

function toISO(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 100) y = y >= 70 ? 1900 + y : 2000 + y; // two-digit year pivot
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

const MIN_SERIAL = 20000; // 1954-10-03 — below this a bare number is not a date
function excelSerialToISO(serial, { date1904 = false } = {}) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n < 1 || n > 2958465) return null;
  const whole = Math.floor(n);
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const dt = new Date(epoch + whole * 86400000);
  if (dt.getUTCFullYear() < 1900) return null;
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function parseNamedMonth(s) {
  const m = s.match(/^(\d{1,2})[\s./-]+([A-Za-z]{3,12})[\s,.-]+(\d{2,4})(?:[T\s].*)?$/);
  if (m) { const mo = MONTHS[m[2].toLowerCase()]; return mo ? toISO(Number(m[3]), mo, Number(m[1])) : null; }
  const m2 = s.match(/^([A-Za-z]{3,12})[\s./-]+(\d{1,2})[\s,.-]+(\d{2,4})(?:[T\s].*)?$/);
  if (m2) { const mo = MONTHS[m2[1].toLowerCase()]; return mo ? toISO(Number(m2[3]), mo, Number(m2[2])) : null; }
  return null;
}

function parseByOrder(s, order) {
  const m = s.match(/^(\d{1,4})[\s./-]+(\d{1,2})[\s./-]+(\d{1,4})(?:[T\s].*)?$/);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]), c = Number(m[3]);
  if (order === 'YMD') return toISO(a, b, c);
  if (order === 'DMY') return toISO(c, b, a);
  if (order === 'MDY') return toISO(c, a, b);
  return null;
}

/** Detect DMY / MDY / YMD for a column, with a confidence and ambiguity flag. */
function detectDateFormat(values, explicit = 'auto', excelNumberFormat = null) {
  const fixed = normalizeDateFormat(explicit);
  if (fixed !== 'auto') return { format: fixed, confidence: 1, ambiguous: false, reason: 'Set by user' };

  if (excelNumberFormat) {
    const h = String(excelNumberFormat).toLowerCase();
    const dPos = h.search(/d{1,4}/), mPos = h.search(/m{1,4}/), yPos = h.search(/y{2,4}/);
    if (dPos >= 0 && mPos >= 0 && yPos >= 0) {
      if (yPos < dPos && yPos < mPos) return { format: 'YMD', confidence: 0.98, ambiguous: false, reason: 'Excel cell format' };
      return { format: dPos < mPos ? 'DMY' : 'MDY', confidence: 0.98, ambiguous: false, reason: 'Excel cell format' };
    }
  }

  let dmy = 0, mdy = 0, ymd = 0, ambiguous = 0, serial = 0, total = 0;
  for (const raw of values) {
    if (isBlank(raw)) continue;
    if (raw instanceof Date) { total++; ymd++; continue; }
    const s = String(raw).trim();
    if (/^\d{4,7}(?:\.\d+)?$/.test(s) && Number(s) >= MIN_SERIAL) { total++; serial++; continue; }
    if (parseNamedMonth(s)) { total++; dmy++; continue; }
    const m = s.match(/^(\d{1,4})[\s./-]+(\d{1,2})[\s./-]+(\d{1,4})/);
    if (!m) continue;
    total++;
    const a = Number(m[1]), b = Number(m[2]);
    if (a >= 1000) { ymd++; continue; }
    if (a > 12 && b <= 12) dmy++;
    else if (b > 12 && a <= 12) mdy++;
    else ambiguous++;
  }
  const conf = (n) => (total ? n / total : 0);
  if (serial > 0 && serial >= Math.max(dmy, mdy, ymd)) return { format: 'SERIAL', confidence: conf(serial), ambiguous: false, reason: 'Excel date serial numbers' };
  if (ymd > 0 && ymd >= dmy && ymd >= mdy) return { format: 'YMD', confidence: conf(ymd), ambiguous: false, reason: 'ISO-style values' };
  if (dmy > 0 && mdy === 0) return { format: 'DMY', confidence: conf(dmy), ambiguous: ambiguous > 0 && dmy === 0, reason: 'Day exceeds 12 in some rows' };
  if (mdy > 0 && dmy === 0) return { format: 'MDY', confidence: conf(mdy), ambiguous: false, reason: 'Month exceeds 12 in some rows' };
  if (dmy !== mdy) return { format: dmy > mdy ? 'DMY' : 'MDY', confidence: conf(Math.max(dmy, mdy)), ambiguous: true, reason: 'Mixed evidence — confirm the format' };
  if (ambiguous > 0) return { format: null, confidence: 0, ambiguous: true, reason: 'Every value fits both DMY and MDY — pick one' };
  return { format: null, confidence: 0, ambiguous: true, reason: 'No date evidence found in this column' };
}

function normalizeDateFormat(format) {
  if (!format || format === 'auto') return 'auto';
  const f = String(format).toUpperCase();
  if (['DMY', 'MDY', 'YMD', 'SERIAL'].includes(f)) return f;
  const n = f.replace(/Y{2,4}/g, 'Y').replace(/M{1,2}/g, 'M').replace(/D{1,2}/g, 'D').replace(/[^YMD]/g, '');
  if (n === 'DMY' || n === 'MDY' || n === 'YMD') return n;
  return 'auto';
}

/** Parse one cell into an ISO date, given the column's detected format. */
function parseDate(value, meta = {}, opts = {}) {
  if (isBlank(value)) return { iso: null, status: 'MISSING' };
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { iso: null, status: 'INVALID' };
    return { iso: `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`, status: 'VALID' };
  }
  const s = String(value).trim();
  const numeric = /^\d{4,7}(?:\.\d+)?$/.test(s);
  if (numeric) {
    // A bare number is a serial only when it is plausibly one, or when the
    // column was detected as serial. Guards against "2026" -> 1905-07-18.
    if (Number(s) >= MIN_SERIAL || meta.format === 'SERIAL') {
      const iso = excelSerialToISO(s, { date1904: !!opts.date1904 });
      if (iso) return { iso, status: 'VALID' };
    }
    return { iso: null, status: 'INVALID' };
  }
  const named = parseNamedMonth(s);
  if (named) return { iso: named, status: 'VALID' };
  if (!meta.format || meta.format === 'SERIAL') return { iso: null, status: 'AMBIGUOUS' };
  const iso = parseByOrder(s, meta.format);
  return iso ? { iso, status: 'VALID' } : { iso: null, status: 'INVALID' };
}

const dayNumber = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
};

/**
 * Compare dates with an asymmetric window: B may fall from `before` days
 * earlier to `after` days later than A.
 */
function compareDates(a, b, metaA, metaB, { before = 0, after = 0, date1904A = false, date1904B = false } = {}) {
  const pa = parseDate(a, metaA, { date1904: date1904A });
  const pb = parseDate(b, metaB, { date1904: date1904B });
  if (pa.status === 'MISSING' && pb.status === 'MISSING') return { ok: true, status: 'BOTH_BLANK', diffDays: 0, isoA: null, isoB: null };
  if (pa.status === 'AMBIGUOUS' || pb.status === 'AMBIGUOUS') return { ok: false, status: 'AMBIGUOUS_FORMAT', diffDays: null, isoA: pa.iso, isoB: pb.iso };
  if (pa.status === 'INVALID' || pb.status === 'INVALID') return { ok: false, status: 'UNPARSEABLE', diffDays: null, isoA: pa.iso, isoB: pb.iso };
  if (pa.status === 'MISSING' || pb.status === 'MISSING') return { ok: false, status: 'MISSING_ONE_SIDE', diffDays: null, isoA: pa.iso, isoB: pb.iso };
  // Reported as File A date − File B date (0 = same day). The optional window
  // still reads from B's point of view: B may be `before` days earlier to
  // `after` days later than A. With the default window of 0 only 0 matches.
  const diff = dayNumber(pa.iso) - dayNumber(pb.iso);
  const lo = -Math.abs(Number(before) || 0);
  const hi = Math.abs(Number(after) || 0);
  const ok = -diff >= lo && -diff <= hi;
  return { ok, status: diff === 0 ? 'EXACT' : ok ? 'WITHIN_WINDOW' : 'OUT_OF_WINDOW', diffDays: diff, isoA: pa.iso, isoB: pb.iso };
};

const formatISO = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

/* --------------------------------------------------------------- profiling */

/**
 * Infer a column's comparison type from its values, never from its name.
 * Returns 'date' | 'amount' | 'identifier' | 'text'. An empty column is
 * 'text', which the engine treats as unknown-but-safe.
 */
function inferColumnType(values) {
  let numeric = 0, dated = 0, filled = 0;
  for (const v of values) {
    if (isBlank(v)) continue;
    filled++;
    if (v instanceof Date) { dated++; continue; }
    const s = String(v).trim();
    if (/^\d{1,4}[\s./-]+\d{1,2}[\s./-]+\d{1,4}/.test(s) || parseNamedMonth(s)) { dated++; continue; }
    if (isNumericValue(v)) numeric++;
  }
  if (!filled) return 'text';
  if (dated / filled >= 0.7) return 'date';
  if (numeric / filled >= 0.7) return 'amount';
  if (T.looksLikeIdentifier(values)) return 'identifier';
  return 'text';
}

module.exports = {
  isBlank, pad2,
  parseMoneyMinor, isNumericValue, formatMinor, compareMoney,
  normalizeKey, isSummaryKey, compileRegex, DEFAULT_KEY_RULES,
  toISO, excelSerialToISO, detectDateFormat, normalizeDateFormat, parseDate, compareDates, formatISO, dayNumber,
  inferColumnType, MIN_SERIAL,
  compareText: T.compareText,
  normalizeText: T.normalizeText,
  resolveTextThresholds: T.resolveThresholds,
  DEFAULT_TEXT_THRESHOLDS: T.DEFAULT_THRESHOLDS,
  TEXT_WEIGHTS: T.WEIGHTS,
};
