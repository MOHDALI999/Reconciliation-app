'use strict';
/**
 * Automatic text comparison engine.
 *
 * Design rules:
 *  1. The score is always produced by a mathematical string-similarity
 *     algorithm. Nothing in this file assigns a percentage by hand, and no
 *     branch nudges a computed score towards a nicer looking number.
 *  2. Deterministic. Same two inputs -> same score, always. No randomness,
 *     no model calls, no time or locale dependence.
 *  3. Conservative. Normalisation only removes formatting (case, spacing,
 *     punctuation, separators). It never expands abbreviations, never stems
 *     words and never rewrites digits, so the identity of a financial value
 *     cannot change. Original values are never modified.
 *  4. Explainable. Every comparison returns the originals, the normalised
 *     forms, the score, the raw signals behind the score, a status and a
 *     reason that describes what actually happened.
 *  5. Cheapest test first: empty check -> raw equality -> normalised equality
 *     -> token analysis -> character similarity. Fuzzy maths only runs when
 *     the cheap tests could not resolve the pair, and every result is cached.
 *
 * The similarity score answers one question only: "how similar is this text?"
 * It is deliberately NOT a statement that two rows are the same financial
 * entity. That decision stays with the reconciliation engine.
 */

/* ------------------------------------------------------------- thresholds */

/**
 * Classification threshold, in percent. One number, one rule:
 *   similarity >= match  -> MATCH      (shown to the user as "Match")
 *   similarity <  match  -> MISMATCH   (shown to the user as "Not Match")
 * Default 50. Configurable per run through settings.textThresholds.match;
 * documented in README.md. There is deliberately no middle "review" band:
 * a non-technical user gets one of two answers for every text cell.
 *
 * The legacy shape { high, review } (older saved rules) is tolerated but
 * ignored, so an old browser session cannot silently move the 50% line.
 */
const DEFAULT_THRESHOLDS = Object.freeze({ match: 50 });

const clampPct = (n) => Math.min(100, Math.max(0, n));

function resolveThresholds(t) {
  const match = Number(t?.match);
  return { match: Number.isFinite(match) ? clampPct(match) : DEFAULT_THRESHOLDS.match };
}

/** Plain-language label for a text status. Exactly two answers for scored text. */
const STATUS_LABEL = Object.freeze({
  MATCH: 'Match',
  MISMATCH: 'Not Match',
  EMPTY: 'Both empty',
  NOT_FOUND_IN_FILE_A: 'Missing in A',
  NOT_FOUND_IN_FILE_B: 'Missing in B',
});

/* --------------------------------------------------------- score weighting */

/**
 * Final score = weighted blend of three computed signals. The weights sum to
 * exactly 1, which is what guarantees 0 <= similarity <= 100 without clamping
 * tricks.
 *   token       — order-independent token alignment (same words, any order)
 *   charSorted  — character similarity of the token-sorted strings
 *   charDirect  — character similarity of the strings as written (order aware)
 * A pure reorder therefore scores high (token + charSorted agree) but not
 * 100, because charDirect legitimately disagrees.
 */
const WEIGHTS = Object.freeze({ token: 0.55, charSorted: 0.30, charDirect: 0.15 });

/** A token pair below this character similarity is not treated as aligned. */
const TOKEN_ALIGN_FLOOR = 0.6;

/** Character-level maths is capped so a pathological cell cannot stall a run. */
const CHAR_LIMIT = 256;

/* -------------------------------------------------------------- primitives */

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';

/**
 * Formatting-only normalisation.
 * Unicode-composes, optionally case-folds, then replaces every run of
 * non-letter/non-digit characters with a single space. Letters and digits of
 * any script survive untouched, so "ABC TRADERS PVT. LTD." and
 * "abc traders pvt ltd" both become "abc traders pvt ltd", while
 * "INV 1001" and "INV 1002" stay different.
 */
function normalizeText(value, { caseSensitive = false } = {}) {
  let s = value === null || value === undefined ? '' : String(value);
  if (!s) return '';
  s = s.normalize('NFKC');
  if (!caseSensitive) s = s.toLowerCase();
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return s;
}

const tokenize = (normalized) => (normalized ? normalized.split(' ') : []);

const tokenSorted = (tokens) => [...tokens].sort().join(' ');

/**
 * Levenshtein edit distance, two-row dynamic programming.
 * O(n·m) time, O(min(n,m)) memory, with a common-affix shortcut.
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  // Strip the shared prefix and suffix: they cannot contribute edits.
  let start = 0;
  let endA = a.length;
  let endB = b.length;
  while (start < endA && start < endB && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) { endA--; endB--; }
  const s = a.slice(start, endA);
  const t = b.slice(start, endB);
  if (!s.length) return t.length;
  if (!t.length) return s.length;

  const short = s.length <= t.length ? s : t;
  const long = s.length <= t.length ? t : s;
  const width = short.length + 1;
  const prev = new Uint32Array(width);
  const curr = new Uint32Array(width);
  for (let i = 0; i < width; i++) prev[i] = i;

  for (let j = 1; j <= long.length; j++) {
    curr[0] = j;
    const cj = long.charCodeAt(j - 1);
    for (let i = 1; i < width; i++) {
      const cost = short.charCodeAt(i - 1) === cj ? 0 : 1;
      const del = prev[i] + 1;
      const ins = curr[i - 1] + 1;
      const sub = prev[i - 1] + cost;
      curr[i] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
    }
    prev.set(curr);
  }
  return prev[width - 1];
}

/** Levenshtein similarity in 0..1: 1 - distance / length of the longer side. */
function levenshteinSimilarity(a, b) {
  const longest = Math.max(a.length, b.length);
  if (!longest) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/** Jaro similarity in 0..1. */
function jaro(a, b) {
  if (a === b) return a.length ? 1 : 1;
  const la = a.length;
  const lb = b.length;
  if (!la || !lb) return 0;
  const window = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const usedA = new Uint8Array(la);
  const usedB = new Uint8Array(lb);
  let matches = 0;

  for (let i = 0; i < la; i++) {
    const from = Math.max(0, i - window);
    const to = Math.min(lb - 1, i + window);
    for (let j = from; j <= to; j++) {
      if (usedB[j] || a.charCodeAt(i) !== b.charCodeAt(j)) continue;
      usedA[i] = 1; usedB[j] = 1; matches++;
      break;
    }
  }
  if (!matches) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!usedA[i]) continue;
    while (!usedB[k]) k++;
    if (a.charCodeAt(i) !== b.charCodeAt(k)) transpositions++;
    k++;
  }
  return (matches / la + matches / lb + (matches - transpositions / 2) / matches) / 3;
}

/** Jaro-Winkler similarity in 0..1 (standard 0.1 prefix scale, 4-char cap). */
function jaroWinkler(a, b) {
  const j = jaro(a, b);
  if (j === 0) return 0;
  let prefix = 0;
  const max = Math.min(4, a.length, b.length);
  while (prefix < max && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
  return j + prefix * 0.1 * (1 - j);
}

const cap = (s) => (s.length > CHAR_LIMIT ? s.slice(0, CHAR_LIMIT) : s);

/**
 * Character similarity: the mean of two independent, mathematically valid
 * string metrics. Levenshtein carries edit distance, Jaro-Winkler carries
 * character agreement and shared prefixes; averaging them keeps both signals
 * without either dominating.
 */
function charSimilarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const x = cap(a);
  const y = cap(b);
  return (levenshteinSimilarity(x, y) + jaroWinkler(x, y)) / 2;
}

/**
 * Order-independent token similarity, Dice-style and length weighted.
 *
 * Exact tokens are aligned first (cheap multiset intersection), then the
 * leftovers are aligned greedily by character similarity in a deterministic
 * order, so "TRADERS" still recognises "TRADER". Longer tokens carry more
 * weight than short ones, which is what stops a shared "ltd" from inflating
 * an otherwise different company name.
 */
function tokenSimilarity(tokensA, tokensB) {
  if (!tokensA.length && !tokensB.length) return { score: 1, exact: 0, aligned: 0, onlyA: [], onlyB: [] };
  if (!tokensA.length || !tokensB.length) return { score: 0, exact: 0, aligned: 0, onlyA: tokensA.slice(0, 4), onlyB: tokensB.slice(0, 4) };

  const totalWeight = tokensA.reduce((t, x) => t + x.length, 0) + tokensB.reduce((t, x) => t + x.length, 0);
  if (!totalWeight) return { score: 1, exact: 0, aligned: 0, onlyA: [], onlyB: [] };

  const countsB = new Map();
  for (const t of tokensB) countsB.set(t, (countsB.get(t) || 0) + 1);

  let gained = 0;
  let exact = 0;
  const leftoverA = [];
  for (const t of tokensA) {
    const n = countsB.get(t) || 0;
    if (n > 0) { countsB.set(t, n - 1); gained += 2 * t.length; exact++; }
    else leftoverA.push(t);
  }
  const leftoverB = [];
  for (const [t, n] of countsB) for (let i = 0; i < n; i++) leftoverB.push(t);

  // Deterministic greedy alignment of what is left: longest first, then
  // alphabetical, so the outcome never depends on input order.
  const order = (x, y) => (y.length - x.length) || (x < y ? -1 : x > y ? 1 : 0);
  leftoverA.sort(order);
  leftoverB.sort(order);

  let aligned = 0;
  const taken = new Uint8Array(leftoverB.length);
  const matchedA = new Set();
  for (const a of leftoverA) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < leftoverB.length; i++) {
      if (taken[i]) continue;
      const score = charSimilarity(a, leftoverB[i]);
      if (score > bestScore + 1e-12) { bestScore = score; bestIndex = i; }
    }
    if (bestIndex < 0 || bestScore < TOKEN_ALIGN_FLOOR) continue;
    taken[bestIndex] = 1;
    matchedA.add(a);
    gained += (a.length + leftoverB[bestIndex].length) * bestScore;
    aligned++;
  }

  const score = gained / totalWeight;
  // Tokens that never found a partner. Deterministic (leftovers are sorted)
  // and capped, so a reason can name what actually differs without cost.
  const onlyA = [];
  for (const a of leftoverA) if (!matchedA.has(a)) onlyA.push(a);
  const onlyB = [];
  for (let i = 0; i < leftoverB.length; i++) if (!taken[i]) onlyB.push(leftoverB[i]);
  return {
    score: score > 1 ? 1 : score < 0 ? 0 : score,
    exact,
    aligned,
    onlyA: onlyA.slice(0, 4),
    onlyB: onlyB.slice(0, 4),
  };
}

/* ------------------------------------------------------------------ caches */

const NORM_CACHE_MAX = 120_000;
const PAIR_CACHE_MAX = 250_000;
const normCache = new Map();
const pairCache = new Map();

function cachedNormalize(raw, caseSensitive) {
  const key = caseSensitive ? `1\u0000${raw}` : `0\u0000${raw}`;
  const hit = normCache.get(key);
  if (hit !== undefined) return hit;
  const value = normalizeText(raw, { caseSensitive });
  if (normCache.size >= NORM_CACHE_MAX) normCache.clear();
  normCache.set(key, value);
  return value;
}

function resetCaches() { normCache.clear(); pairCache.clear(); }

/* ----------------------------------------------------------- the comparison */

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Compute the similarity of two already-normalised, non-empty, non-identical
 * strings. Pure maths; the caller owns the cheap short-circuits.
 */
function similarityOf(normA, normB) {
  const tokensA = tokenize(normA);
  const tokensB = tokenize(normB);
  const token = tokenSimilarity(tokensA, tokensB);
  const sortedA = tokenSorted(tokensA);
  const sortedB = tokenSorted(tokensB);

  const charDirect = charSimilarity(cap(normA), cap(normB));
  const charSorted = sortedA === normA && sortedB === normB
    ? charDirect
    : charSimilarity(cap(sortedA), cap(sortedB));

  const score = WEIGHTS.token * token.score
    + WEIGHTS.charSorted * charSorted
    + WEIGHTS.charDirect * charDirect;

  const levA = cap(normA);
  const levB = cap(normB);
  return {
    similarity: round2(Math.min(100, Math.max(0, score * 100))),
    signals: {
      token: round2(token.score * 100),
      charDirect: round2(charDirect * 100),
      charSorted: round2(charSorted * 100),
      levenshtein: round2(levenshteinSimilarity(levA, levB) * 100),
      jaroWinkler: round2(jaroWinkler(levA, levB) * 100),
      tokensA: tokensA.length,
      tokensB: tokensB.length,
      tokensExact: token.exact,
      tokensAligned: token.aligned,
      onlyA: token.onlyA || [],
      onlyB: token.onlyB || [],
      truncated: normA.length > CHAR_LIMIT || normB.length > CHAR_LIMIT,
      weights: WEIGHTS,
    },
  };
}

/** Quote a short list of tokens for a human-readable reason. */
function quoteTokens(list) {
  return list.map((t) => `“${t}”`).join(', ');
}

/**
 * Describe, in plain words, what the maths found. Derived from the signals —
 * never a guess, and never a restatement of the threshold decision.
 */
function describeDifference(signals) {
  const onlyA = signals.onlyA || [];
  const onlyB = signals.onlyB || [];
  if (signals.token >= 99 && signals.charDirect < 90) return 'same words, different order';
  if (onlyA.length && onlyB.length) {
    return `file A has ${quoteTokens(onlyA)} where file B has ${quoteTokens(onlyB)}`;
  }
  if (onlyB.length) return `file B has extra ${onlyB.length > 1 ? 'words' : 'word'} ${quoteTokens(onlyB)}`;
  if (onlyA.length) return `file A has extra ${onlyA.length > 1 ? 'words' : 'word'} ${quoteTokens(onlyA)}`;
  if (signals.tokensA !== signals.tokensB) {
    return `${signals.tokensA} words vs ${signals.tokensB} words, spelling differs`;
  }
  if (signals.token >= 99) return 'same words, spacing or punctuation differs';
  return 'same words with spelling differences';
}

/**
 * Threshold decision only. `reason` describes what differs (from the
 * signals); `decision` states the rule that was applied, in one line, so an
 * export can carry both without repeating the score twice.
 */
function classify(similarity, thresholds, signals) {
  const line = thresholds.match;
  if (similarity >= 100) {
    return { status: 'MATCH', matchType: 'FUZZY_EXACT', reason: 'identical after normalisation', decision: `100% ≥ ${line}% → Match` };
  }
  const detail = describeDifference(signals);
  const reordered = signals.token >= 99 && signals.charDirect < 90;
  if (similarity >= line) {
    return { status: 'MATCH', matchType: reordered ? 'TOKEN_REORDER' : 'FUZZY', reason: detail, decision: `${similarity}% ≥ ${line}% → Match` };
  }
  return { status: 'MISMATCH', matchType: 'FUZZY_LOW', reason: detail, decision: `${similarity}% < ${line}% → Not Match` };
}

/**
 * Compare two text values.
 *
 * @param {*} a raw value from file A (never modified)
 * @param {*} b raw value from file B (never modified)
 * @param {object} [opts]
 * @param {'text'|'identifier'} [opts.mode] identifier = normalised exact only,
 *        no fuzzy maths, because "INV-1001" and "INV-1002" are not 99% the
 *        same invoice.
 * @param {boolean} [opts.caseSensitive] keep case during normalisation
 * @param {{match:number}} [opts.thresholds] match line in percent (default 50)
 * @returns {{originalA, originalB, normalizedA, normalizedB, similarity,
 *            status, matchType, reason, decision, signals}}
 *          similarity is a number 0..100 with two decimals kept, or null when
 *          a similarity would be meaningless (missing value, identifier).
 */
function compareText(a, b, opts = {}) {
  const mode = opts.mode === 'identifier' ? 'identifier' : 'text';
  const caseSensitive = !!opts.caseSensitive;
  const thresholds = resolveThresholds(opts.thresholds);

  const originalA = a === null || a === undefined ? '' : String(a);
  const originalB = b === null || b === undefined ? '' : String(b);

  // 1. empty / missing — never fuzzy-compared
  const emptyA = isBlank(originalA);
  const emptyB = isBlank(originalB);
  if (emptyA && emptyB) {
    return {
      originalA, originalB, normalizedA: '', normalizedB: '', similarity: null,
      status: 'EMPTY', matchType: 'BOTH_EMPTY', reason: 'both values are empty', decision: 'nothing to compare', signals: null,
    };
  }
  if (emptyB) {
    return {
      originalA, originalB, normalizedA: cachedNormalize(originalA, caseSensitive), normalizedB: '', similarity: null,
      status: 'NOT_FOUND_IN_FILE_B', matchType: 'MISSING_B', reason: 'no value in file B', decision: 'missing in B → Not Match', signals: null,
    };
  }
  if (emptyA) {
    return {
      originalA, originalB, normalizedA: '', normalizedB: cachedNormalize(originalB, caseSensitive), similarity: null,
      status: 'NOT_FOUND_IN_FILE_A', matchType: 'MISSING_A', reason: 'no value in file A', decision: 'missing in A → Not Match', signals: null,
    };
  }

  // 2. raw equality — cheapest possible test
  if (originalA === originalB) {
    const n = cachedNormalize(originalA, caseSensitive);
    return {
      originalA, originalB, normalizedA: n, normalizedB: n, similarity: 100,
      status: 'MATCH', matchType: 'EXACT', reason: 'values are identical', decision: `100% ≥ ${thresholds.match}% → Match`, signals: null,
    };
  }

  // 3. normalised equality
  const normalizedA = cachedNormalize(originalA, caseSensitive);
  const normalizedB = cachedNormalize(originalB, caseSensitive);
  if (normalizedA === normalizedB) {
    return {
      originalA, originalB, normalizedA, normalizedB, similarity: 100,
      status: 'MATCH', matchType: 'NORMALIZED_EXACT',
      reason: 'identical once case, spacing and punctuation are ignored', decision: `100% ≥ ${thresholds.match}% → Match`, signals: null,
    };
  }

  // 4. identifiers stop here: they are compared exactly, never approximately
  if (mode === 'identifier') {
    return {
      originalA, originalB, normalizedA, normalizedB, similarity: null,
      status: 'MISMATCH', matchType: 'IDENTIFIER_DIFFERENT',
      reason: 'different identifier — identifiers are compared exactly, not by similarity', decision: 'identifiers differ → Not Match', signals: null,
    };
  }

  // 5. real similarity maths, cached per normalised pair
  const cacheKey = `${caseSensitive ? 1 : 0}\u0000${normalizedA}\u0000${normalizedB}`;
  let computed = pairCache.get(cacheKey);
  if (computed === undefined) {
    computed = similarityOf(normalizedA, normalizedB);
    if (pairCache.size >= PAIR_CACHE_MAX) pairCache.clear();
    pairCache.set(cacheKey, computed);
  }

  const verdict = classify(computed.similarity, thresholds, computed.signals);
  return {
    originalA, originalB, normalizedA, normalizedB,
    similarity: computed.similarity,
    status: verdict.status,
    matchType: verdict.matchType,
    reason: verdict.reason,
    decision: verdict.decision,
    signals: computed.signals,
  };
}

/* ------------------------------------------------------------ type detection */

const ID_SHAPE = /^[\p{L}\p{N}][\p{L}\p{N}\-_/.#]*$/u;
const HAS_DIGIT = /\p{N}/u;

/**
 * Does this column look like an identifier (order id, invoice number, GSTIN)
 * rather than free text? Identifiers are single-token, short, and carry
 * digits. Detected from the values, never from the column name.
 */
function looksLikeIdentifier(values) {
  let filled = 0;
  let shaped = 0;
  let withDigit = 0;
  let totalLength = 0;
  const distinct = new Set();
  for (const v of values) {
    if (isBlank(v)) continue;
    const s = String(v).trim();
    filled++;
    totalLength += s.length;
    if (distinct.size < 5000) distinct.add(s);
    if (ID_SHAPE.test(s) && s.length <= 32) shaped++;
    if (HAS_DIGIT.test(s)) withDigit++;
  }
  if (filled < 3) return false;
  const avgLength = totalLength / filled;
  return shaped / filled >= 0.9
    && withDigit / filled >= 0.6
    && avgLength <= 24
    && distinct.size / Math.min(filled, 5000) >= 0.6;
}

module.exports = {
  compareText,
  normalizeText,
  tokenize,
  levenshtein,
  levenshteinSimilarity,
  jaro,
  jaroWinkler,
  charSimilarity,
  tokenSimilarity,
  looksLikeIdentifier,
  resolveThresholds,
  resetCaches,
  DEFAULT_THRESHOLDS,
  STATUS_LABEL,
  WEIGHTS,
  CHAR_LIMIT,
};
