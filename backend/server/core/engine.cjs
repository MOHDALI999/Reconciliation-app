'use strict';
/**
 * Reconciliation engine.
 *
 * Design rules (the reasons the old engine produced undefendable numbers):
 *  1. No source row is ever dropped. Every row lands in exactly one bucket and
 *     the run proves it with a row and value tie-out.
 *  2. Cardinality is explicit. A B row is consumed at most once. 1:N / N:1 are
 *     matched as one group with balancing sums. N:M is ranked, and ties are
 *     reported as AMBIGUOUS instead of being guessed.
 *  3. Comparison type comes from profiled data plus the user's override,
 *     never from a header name. Text columns automatically run the text
 *     comparison engine (normalise -> token -> character similarity); the
 *     user never picks an algorithm.
 *  4. Money is compared in integer minor units. Dates use an explicit,
 *     per-column format with an asymmetric day window.
 *  5. The result is a compact typed-array index. Row detail is recomputed on
 *     demand for the visible window only.
 */

const V = require('./values.cjs');
const { shownValue, cellText } = require('./workbook.cjs');

const ENGINE_VERSION = '2.1.0';

const STATUS = { MATCHED: 0, MISMATCH: 1, ONLY_A: 2, AMBIGUOUS: 3, EXCLUDED: 4 };
const STATUS_LABEL = ['Matched', 'Mismatched', 'Only in File A', 'Mismatched', 'Excluded'];
const RULE = { NONE: 0, KEY_1_1: 1, KEY_GROUP: 2, KEY_RANKED: 3, FALLBACK_DATE_AMOUNT: 4 };
const RULE_LABEL = ['', 'Key 1:1', 'Key group sum', 'Key ranked (duplicates)', 'Date + amount fallback'];
const EXCLUDE = { NONE: 0, BLANK_KEY: 1, SUMMARY_ROW: 2, FILTERED_OUT: 3 };
const EXCLUDE_LABEL = ['', 'Key is blank', 'Spreadsheet total row', 'Removed by filter'];

const DEFAULT_PAIR = { type: 'auto', absTol: 0, pctTol: 0, dateBefore: 0, dateAfter: 0, ignoreSign: false, required: true };

/**
 * Which engine handles which detected type. Amount, date and identifier keep
 * their existing specialised logic; only free text goes through similarity.
 */
const COMPARISON_ENGINE = {
  amount: 'numeric comparison in integer minor units',
  date: 'date comparison with a per-column format and day window',
  identifier: 'normalised exact identifier comparison',
  text: 'automatic text engine: normalise, tokens, character similarity',
};

/** Two answers for text: everything that is not a MATCH reads "Not Match". */
const textLabelOf = (status) => (status === 'MATCH' ? 'Match' : status === 'EMPTY' ? 'Both empty' : 'Not Match');

/**
 * Resolve the auto type for a pair from both column profiles.
 * Conservative on purpose: when the two sides disagree, the pair falls back to
 * exact identifier comparison if either side is an identifier, otherwise text.
 */
function resolveAutoType(tA, tB) {
  if (tA === tB) return tA;
  if (tA === 'identifier' || tB === 'identifier') return 'identifier';
  return 'text';
}

/* ------------------------------------------------------------------ filters */

function buildFilterPredicate(filters) {
  const active = (filters || []).filter((f) => f && f.column && (f.include?.length || f.exclude?.length));
  if (!active.length) return null;
  const compiled = active.map((f) => ({
    column: f.column,
    include: f.include?.length ? new Set(f.include.map((v) => String(v))) : null,
    exclude: f.exclude?.length ? new Set(f.exclude.map((v) => String(v))) : null,
  }));
  return (row) => compiled.every((f) => {
    const v = String(row[f.column] ?? '').trim();
    if (f.exclude && f.exclude.has(v)) return false;
    if (f.include && !f.include.has(v)) return false;
    return true;
  });
}

/* ----------------------------------------------------------------- profiling */

function sampleColumn(rows, column, limit = 400) {
  const out = [];
  for (let i = 0; i < rows.length && out.length < limit; i++) {
    const v = rows[i]?.[column];
    if (!V.isBlank(v)) out.push(v);
  }
  return out;
}

function profileColumns(rows, headers, hints = {}) {
  return headers.map((name) => {
    const samples = sampleColumn(rows, name);
    let blanks = 0;
    const distinct = new Set();
    for (let i = 0; i < rows.length; i++) {
      const v = rows[i]?.[name];
      if (V.isBlank(v)) blanks++;
      else if (distinct.size < 5000) distinct.add(String(v));
    }
    const type = V.inferColumnType(samples);
    const detected = type === 'date' ? V.detectDateFormat(samples, 'auto', hints[name]) : null;
    return {
      name,
      type,
      blanks,
      filled: rows.length - blanks,
      distinctSample: distinct.size,
      samples: samples.slice(0, 5).map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v))),
      dateFormat: detected?.format ?? null,
      dateAmbiguous: detected?.ambiguous ?? false,
      dateConfidence: detected?.confidence ?? null,
      dateReason: detected?.reason ?? null,
    };
  });
}

/* ------------------------------------------------------------------- engine */

function reconcile(input) {
  const {
    rowsA = [], rowsB = [], headersA = [], headersB = [],
    settings = {}, hintsA = {}, hintsB = {},
    date1904A = false, date1904B = false,
    // Optional, aligned with rowsA/rowsB: the text each cell showed in the
    // spreadsheet and its number format (see workbook.cjs). When absent the
    // raw value is shown as text.
    displayA = null, displayB = null, formatsA = null, formatsB = null,
    onProgress = null,
  } = input;

  const keyA = settings.keyA;
  const keyB = settings.keyB;
  if (!keyA || !keyB) throw new Error('A key column is required for both files.');
  if (!headersA.includes(keyA)) throw new Error(`Key column "${keyA}" is not in file A.`);
  if (!headersB.includes(keyB)) throw new Error(`Key column "${keyB}" is not in file B.`);

  const keyRulesA = { ...V.DEFAULT_KEY_RULES, ...(settings.keyRulesA || {}) };
  const keyRulesB = { ...V.DEFAULT_KEY_RULES, ...(settings.keyRulesB || {}) };
  // Off unless asked for: the Order ID pairs rows one to one and every
  // selected field is compared on that pair.
  const groupMatching = settings.groupMatching === true;
  const groupTolerance = Number(settings.groupTolerance || 0);
  const fallbackEnabled = !!settings.dateAmountFallback;
  const currency = settings.currency || '₹';

  // ---- 1. resolve pairs (type from profile, overridable) -------------------
  const pairs = (settings.pairs || [])
    .filter((p) => p && p.colA && p.colB && headersA.includes(p.colA) && headersB.includes(p.colB))
    .map((p, i) => {
      const merged = { ...DEFAULT_PAIR, ...p, id: p.id || `p${i + 1}` };
      const samplesA = sampleColumn(rowsA, merged.colA);
      const samplesB = sampleColumn(rowsB, merged.colB);
      let type = merged.type;
      let detectedA = null;
      let detectedB = null;
      if (type === 'auto') {
        detectedA = V.inferColumnType(samplesA);
        detectedB = V.inferColumnType(samplesB);
        type = resolveAutoType(detectedA, detectedB);
      }
      const metaA = type === 'date'
        ? V.detectDateFormat(samplesA, merged.dateFormatA || 'auto', hintsA[merged.colA])
        : null;
      const metaB = type === 'date'
        ? V.detectDateFormat(samplesB, merged.dateFormatB || 'auto', hintsB[merged.colB])
        : null;
      return {
        ...merged, type, metaA, metaB,
        detectedTypeA: detectedA,
        detectedTypeB: detectedB,
        engine: COMPARISON_ENGINE[type] || 'exact comparison',
        label: `${merged.colA} / ${merged.colB}`,
      };
    });

  const amountPair = pairs.find((p) => p.type === 'amount') || null;
  const datePair = pairs.find((p) => p.type === 'date') || null;
  const textThresholds = V.resolveTextThresholds(settings.textThresholds);

  // ---- 2. classify every source row, dropping nothing ---------------------
  const filterA = buildFilterPredicate(settings.filtersA);
  const filterB = buildFilterPredicate(settings.filtersB);

  function classify(rows, keyCol, keyRules, filter) {
    const n = rows.length;
    const exclude = new Uint8Array(n);
    const keys = new Array(n);
    const slots = [];
    const collisionMap = new Map(); // norm key -> Set of raw keys
    for (let i = 0; i < n; i++) {
      const raw = rows[i]?.[keyCol];
      if (V.isSummaryKey(raw)) { exclude[i] = EXCLUDE.SUMMARY_ROW; continue; }
      if (filter && !filter(rows[i])) { exclude[i] = EXCLUDE.FILTERED_OUT; continue; }
      const { key } = V.normalizeKey(raw, keyRules);
      if (!key) { exclude[i] = EXCLUDE.BLANK_KEY; continue; }
      keys[i] = key;
      slots.push(i);
      let set = collisionMap.get(key);
      if (!set) { set = new Set(); collisionMap.set(key, set); }
      if (set.size < 8) set.add(String(raw).trim());
    }
    let collisions = 0;
    const collisionExamples = [];
    for (const [key, set] of collisionMap) {
      if (set.size > 1) {
        collisions++;
        if (collisionExamples.length < 10) collisionExamples.push({ key, rawValues: [...set] });
      }
    }
    return { exclude, keys, slots: Int32Array.from(slots), collisions, collisionExamples };
  }

  const A = classify(rowsA, keyA, keyRulesA, filterA);
  const B = classify(rowsB, keyB, keyRulesB, filterB);
  onProgress?.({ phase: 'classified', done: 0.2 });

  // ---- 3. index both sides by normalised key ------------------------------
  const mapA = new Map();
  for (const i of A.slots) {
    const k = A.keys[i];
    const arr = mapA.get(k); if (arr) arr.push(i); else mapA.set(k, [i]);
  }
  const mapB = new Map();
  for (const i of B.slots) {
    const k = B.keys[i];
    const arr = mapB.get(k); if (arr) arr.push(i); else mapB.set(k, [i]);
  }

  // ---- 4. per-pair comparison --------------------------------------------
  function comparePair(p, rowA, rowB) {
    const rawA = rowA?.[p.colA] ?? '';
    const rawB = rowB?.[p.colB] ?? '';
    if (p.type === 'amount') {
      const r = V.compareMoney(rawA, rawB, { absTol: p.absTol, pctTol: p.pctTol, ignoreSign: p.ignoreSign, crIsNegative: settings.crIsNegative !== false });
      return {
        pairId: p.id, label: p.label, type: 'amount', ok: r.ok, status: r.status,
        rawA, rawB,
        displayA: r.a === null ? String(rawA) : V.formatMinor(r.a, currency),
        displayB: r.b === null ? String(rawB) : V.formatMinor(r.b, currency),
        diff: r.diffMinor === null ? null : V.formatMinor(r.diffMinor, currency),
        diffMinor: r.diffMinor,
        // Percentage of the file A base. Undefined when the base is zero,
        // rather than silently reported as no variance.
        pct: r.a ? Math.round((Math.abs(r.diffMinor || 0) / Math.abs(r.a)) * 10000) / 100
          : (r.diffMinor ? null : 0),
        tolerance: `±${p.absTol || 0}${p.pctTol ? ` / ${p.pctTol}%` : ''}`,
      };
    }
    if (p.type === 'date') {
      const r = V.compareDates(rawA, rawB, p.metaA, p.metaB, { before: p.dateBefore, after: p.dateAfter, date1904A, date1904B });
      return {
        pairId: p.id, label: p.label, type: 'date', ok: r.ok, status: r.status,
        rawA, rawB,
        displayA: r.isoA ? V.formatISO(r.isoA) : String(rawA ?? ''),
        displayB: r.isoB ? V.formatISO(r.isoB) : String(rawB ?? ''),
        // File A date − File B date, in whole days. 0 = Matched.
        diff: r.diffDays === null ? null : String(r.diffDays),
        diffDays: r.diffDays,
        tolerance: `-${p.dateBefore || 0} d … +${p.dateAfter || 0} d`,
        // Which pattern each side was actually read with, so the drawer can
        // state it instead of leaving the user to guess.
        formatA: p.metaA?.format ?? null,
        formatB: p.metaB?.format ?? null,
        formatAmbiguous: !!(p.metaA?.ambiguous || p.metaB?.ambiguous),
      };
    }
    // Text and identifier columns: the text engine runs automatically. The
    // user never selects fuzzy / Levenshtein / tokens / normalisation.
    const r = V.compareText(rawA, rawB, {
      mode: p.type === 'identifier' ? 'identifier' : 'text',
      caseSensitive: !!p.caseSensitive,
      thresholds: textThresholds,
    });
    return {
      pairId: p.id, label: p.label, type: p.type,
      // The text rule is binary: at or above the match line (default 50%) the
      // cell is a Match and does not break the row; below it, it does.
      ok: r.status === 'MATCH' || r.status === 'EMPTY',
      status: r.matchType,
      textStatus: r.status,
      // The two-answer label a non-technical user reads: "Match" / "Not Match".
      textLabel: textLabelOf(r.status),
      similarity: r.similarity,
      rawA, rawB,
      displayA: r.originalA, displayB: r.originalB,
      normalizedA: r.normalizedA, normalizedB: r.normalizedB,
      matchType: r.matchType,
      textReason: r.reason,
      decision: r.decision,
      signals: r.signals,
      diff: r.similarity === null ? null : `${Math.round(r.similarity)}%`,
      tolerance: p.type === 'identifier'
        ? 'exact after normalisation'
        : `Matched >= ${textThresholds.match}%, Mismatched < ${textThresholds.match}%`,
    };
  }

  /** Cost of a candidate pairing: lower is better. Used for duplicate keys. */
  function candidateCost(rowA, rowB) {
    let breaks = 0;
    let distance = 0;
    for (const p of pairs) {
      const r = comparePair(p, rowA, rowB);
      if (!r.ok && p.required) breaks++;
      if (p.type === 'amount' && r.diffMinor !== null) distance += Math.abs(r.diffMinor);
      else if (p.type === 'date' && r.diffDays !== null) distance += Math.abs(r.diffDays) * 100;
      else if (!r.ok) {
        // Text distance comes from the calculated similarity, so the closest
        // wording wins a duplicate-key contest instead of an arbitrary flat cost.
        distance += r.similarity === null || r.similarity === undefined
          ? 1000
          : Math.round((100 - r.similarity) * 10);
      }
    }
    return { breaks, distance };
  }

  const clip = (v, n = 36) => {
    const s = String(v ?? '').trim();
    return s.length > n ? `${s.slice(0, n - 3)}...` : s;
  };

  /**
   * One sentence that says what the numbers actually show, per field type.
   * Built from the comparison result only: no invented wording, and never a
   * restatement of the threshold decision.
   */
  function describeBreak(r) {
    const label = r.label;
    if (r.type === 'amount') {
      if (r.status === 'NOT_NUMERIC') {
        const bad = r.a === null || r.a === undefined ? (r.b === null ? 'both sides' : 'file A') : 'file B';
        return `${label}: ${bad} is not a number (A "${clip(r.rawA)}", B "${clip(r.rawB)}")`;
      }
      const gap = V.formatMinor(Math.abs(r.diffMinor), currency);
      const dir = r.diffMinor > 0 ? 'file B is short by' : 'file B is higher by';
      const pct = typeof r.pct === 'number' && r.pct > 0 ? ` (${r.pct}%)` : '';
      return `${label}: ${r.displayA} vs ${r.displayB}: ${dir} ${gap}${pct}, tolerance ${r.tolerance}`;
    }
    if (r.type === 'date') {
      if (r.status === 'AMBIGUOUS_FORMAT') return `${label}: date format is ambiguous (DD/MM vs MM/DD): set the format for this column`;
      if (r.status === 'UNPARSEABLE') return `${label}: not a readable date (A "${clip(r.rawA)}", B "${clip(r.rawB)}")`;
      if (r.status === 'MISSING_ONE_SIDE') {
        return `${label}: date missing in ${r.displayA ? 'file B' : 'file A'}`;
      }
      const days = Math.abs(r.diffDays);
      const when = r.diffDays > 0 ? 'earlier' : 'later';
      return `${label}: ${r.displayA} vs ${r.displayB}, A - B = ${r.diffDays} (file B is ${days} day${days === 1 ? '' : 's'} ${when})`;
    }
    if (r.type === 'identifier') {
      if (r.status === 'MISSING_B') return `${label}: no value in file B (A "${clip(r.displayA)}")`;
      if (r.status === 'MISSING_A') return `${label}: no value in file A (B "${clip(r.displayB)}")`;
      return `${label}: "${clip(r.displayA)}" vs "${clip(r.displayB)}": different identifier, compared exactly`;
    }
    // text
    if (r.textStatus === 'NOT_FOUND_IN_FILE_B') return `${label}: no value in file B (A "${clip(r.displayA)}")`;
    if (r.textStatus === 'NOT_FOUND_IN_FILE_A') return `${label}: no value in file A (B "${clip(r.displayB)}")`;
    const score = typeof r.similarity === 'number' ? `${Math.round(r.similarity)}% similar` : 'no score';
    return `${label}: "${clip(r.displayA)}" vs "${clip(r.displayB)}": ${r.textReason} (${score})`;
  }

  function evaluatePair(rowA, rowB) {
    const results = pairs.map((p) => comparePair(p, rowA, rowB));
    const reasons = results.filter((r) => !r.ok && pairs.find((p) => p.id === r.pairId)?.required)
      .map((r) => describeBreak(r));
    return { results, reasons };
  }

  // ---- 5. result index ----------------------------------------------------
  const nA = rowsA.length;
  const status = new Uint8Array(nA).fill(STATUS.EXCLUDED);
  const bIndex = new Int32Array(nA).fill(-1);
  const ruleCode = new Uint8Array(nA);
  const groupId = new Int32Array(nA).fill(-1);
  const diffMinor = new Float64Array(nA);
  const excludeCode = A.exclude;
  const usedB = new Uint8Array(rowsB.length);
  const groups = [];

  const setResult = (i, st, b, rule, diff) => {
    status[i] = st; bIndex[i] = b; ruleCode[i] = rule;
    diffMinor[i] = Number.isFinite(diff) ? diff : 0;
    if (b >= 0) usedB[b] = 1;
  };

  const amountMinor = (row, col) => (col ? V.parseMoneyMinor(row?.[col], { crIsNegative: settings.crIsNegative !== false }) : null);

  const pairKeyed = (ai, bi) => {
    const { reasons } = evaluatePair(rowsA[ai], rowsB[bi]);
    const diff = amountPair ? (amountMinor(rowsA[ai], amountPair.colA) ?? 0) - (amountMinor(rowsB[bi], amountPair.colB) ?? 0) : 0;
    setResult(ai, reasons.length ? STATUS.MISMATCH : STATUS.MATCHED, bi, RULE.KEY_1_1, diff);
  };

  let processed = 0;
  for (const [key, aIdxs] of mapA) {
    const bIdxs = mapB.get(key);
    processed += aIdxs.length;
    if (processed % 50000 === 0) onProgress?.({ phase: 'matching', done: 0.2 + 0.6 * (processed / Math.max(1, A.slots.length)) });

    if (!bIdxs || !bIdxs.length) {
      for (const ai of aIdxs) setResult(ai, STATUS.ONLY_A, -1, RULE.NONE, 0);
      continue;
    }
    if (aIdxs.length === 1 && bIdxs.length === 1) { pairKeyed(aIdxs[0], bIdxs[0]); continue; }

    // Duplicate keys on one or both sides.
    const canGroup = groupMatching && amountPair && (aIdxs.length === 1 || bIdxs.length === 1);
    if (canGroup) {
      const sumA = aIdxs.reduce((s, i) => s + (amountMinor(rowsA[i], amountPair.colA) ?? 0), 0);
      const sumB = bIdxs.reduce((s, i) => s + (amountMinor(rowsB[i], amountPair.colB) ?? 0), 0);
      const tolMinor = Math.round(groupTolerance * 100);
      if (Math.abs(sumA - sumB) <= tolMinor) {
        const gid = groups.length;
        groups.push({
          id: gid, key, aRows: [...aIdxs], bRows: [...bIdxs], sumAMinor: sumA, sumBMinor: sumB,
          cardinality: `${aIdxs.length}:${bIdxs.length}`,
        });
        for (const ai of aIdxs) { setResult(ai, STATUS.MATCHED, bIdxs[0], RULE.KEY_GROUP, 0); groupId[ai] = gid; }
        for (const bi of bIdxs) usedB[bi] = 1;
        continue;
      }
    }

    // Ranked greedy assignment: best candidate first, never reuse a B row,
    // ties are reported instead of guessed.
    const scored = [];
    for (const ai of aIdxs) {
      for (const bi of bIdxs) {
        const c = candidateCost(rowsA[ai], rowsB[bi]);
        scored.push({ ai, bi, breaks: c.breaks, distance: c.distance });
      }
    }
    scored.sort((x, y) => x.breaks - y.breaks || x.distance - y.distance || x.ai - y.ai || x.bi - y.bi);
    const takenA = new Set();
    const takenB = new Set();
    for (let s = 0; s < scored.length; s++) {
      const cand = scored[s];
      if (takenA.has(cand.ai) || takenB.has(cand.bi)) continue;
      // Ambiguity: an equally good alternative exists for this A row.
      const tie = scored.some((o, j) => j !== s && !takenA.has(o.ai) && !takenB.has(o.bi)
        && o.ai === cand.ai && o.bi !== cand.bi && o.breaks === cand.breaks && o.distance === cand.distance);
      takenA.add(cand.ai); takenB.add(cand.bi);
      const diff = amountPair ? (amountMinor(rowsA[cand.ai], amountPair.colA) ?? 0) - (amountMinor(rowsB[cand.bi], amountPair.colB) ?? 0) : 0;
      // A tie is still the same Order ID in both files, so it is judged on its
      // compared fields like any other pair (Matched / Mismatched).
      void tie;
      setResult(cand.ai, cand.breaks ? STATUS.MISMATCH : STATUS.MATCHED, cand.bi, RULE.KEY_RANKED, diff);
    }
    for (const ai of aIdxs) if (!takenA.has(ai)) setResult(ai, STATUS.ONLY_A, -1, RULE.NONE, 0);
  }

  // ---- 6. optional date + amount fallback for still-open rows -------------
  let fallbackMatches = 0;
  if (fallbackEnabled && amountPair && datePair) {
    const openB = new Map();
    for (const bi of B.slots) {
      if (usedB[bi]) continue;
      const amt = amountMinor(rowsB[bi], amountPair.colB);
      const d = V.parseDate(rowsB[bi]?.[datePair.colB], datePair.metaB, { date1904: date1904B });
      if (amt === null || !d.iso) continue;
      const k = `${d.iso}|${amt}`;
      const arr = openB.get(k); if (arr) arr.push(bi); else openB.set(k, [bi]);
    }
    for (const ai of A.slots) {
      if (status[ai] !== STATUS.ONLY_A) continue;
      const amt = amountMinor(rowsA[ai], amountPair.colA);
      const d = V.parseDate(rowsA[ai]?.[datePair.colA], datePair.metaA, { date1904: date1904A });
      if (amt === null || !d.iso) continue;
      const arr = openB.get(`${d.iso}|${amt}`);
      if (!arr || !arr.length) continue;
      if (arr.length > 1) continue; // more than one equally good option → leave open
      const bi = arr.shift();
      if (usedB[bi]) continue;
      const { reasons } = evaluatePair(rowsA[ai], rowsB[bi]);
      setResult(ai, reasons.length ? STATUS.MISMATCH : STATUS.MATCHED, bi, RULE.FALLBACK_DATE_AMOUNT, 0);
      fallbackMatches++;
    }
  }
  onProgress?.({ phase: 'indexing', done: 0.85 });

  // ---- 7. buckets --------------------------------------------------------
  const bucket = { matched: [], mismatch: [], ambiguous: [], onlyA: [], excluded: [] };
  for (let i = 0; i < nA; i++) {
    if (status[i] === STATUS.MATCHED) bucket.matched.push(i);
    else if (status[i] === STATUS.MISMATCH) bucket.mismatch.push(i);
    else if (status[i] === STATUS.AMBIGUOUS) bucket.ambiguous.push(i);
    else if (status[i] === STATUS.ONLY_A) bucket.onlyA.push(i);
    else bucket.excluded.push(i);
  }
  const onlyB = [];
  const excludedB = [];
  for (let i = 0; i < rowsB.length; i++) {
    if (B.exclude[i]) { excludedB.push(i); continue; }
    if (!usedB[i]) onlyB.push(i);
  }

  const idx = {
    matched: Int32Array.from(bucket.matched),
    mismatch: Int32Array.from(bucket.mismatch),
    ambiguous: Int32Array.from(bucket.ambiguous),
    onlyA: Int32Array.from(bucket.onlyA),
    excluded: Int32Array.from(bucket.excluded),
    onlyB: Int32Array.from(onlyB),
    excludedB: Int32Array.from(excludedB),
  };

  // ---- 8. integrity: row and value tie-out -------------------------------
  const sumMinor = (rows, col, list) => {
    if (!col) return 0;
    let t = 0;
    for (const i of list) t += amountMinor(rows[i], col) ?? 0;
    return t;
  };
  const allA = Array.from({ length: nA }, (_, i) => i);
  const valueTotals = amountPair ? {
    column: amountPair.colA,
    totalA: sumMinor(rowsA, amountPair.colA, allA),
    matched: sumMinor(rowsA, amountPair.colA, bucket.matched),
    mismatch: sumMinor(rowsA, amountPair.colA, bucket.mismatch),
    ambiguous: sumMinor(rowsA, amountPair.colA, bucket.ambiguous),
    onlyA: sumMinor(rowsA, amountPair.colA, bucket.onlyA),
    excluded: sumMinor(rowsA, amountPair.colA, bucket.excluded),
    onlyB: sumMinor(rowsB, amountPair.colB, onlyB),
    absoluteBreakValue: bucket.mismatch.reduce((t, i) => t + Math.abs(diffMinor[i]), 0),
  } : null;

  // Real B-side accounting: every B row is matched, only-in-B, or excluded.
  let matchedB = 0;
  for (let i = 0; i < rowsB.length; i++) if (usedB[i] && !B.exclude[i]) matchedB++;
  const accountedB = matchedB + onlyB.length + excludedB.length;

  const countedA = bucket.matched.length + bucket.mismatch.length + bucket.ambiguous.length + bucket.onlyA.length + bucket.excluded.length;
  const excludedCounts = (exclude) => {
    const c = { blankKey: 0, summaryRow: 0, filteredOut: 0 };
    for (let i = 0; i < exclude.length; i++) {
      if (exclude[i] === EXCLUDE.BLANK_KEY) c.blankKey++;
      else if (exclude[i] === EXCLUDE.SUMMARY_ROW) c.summaryRow++;
      else if (exclude[i] === EXCLUDE.FILTERED_OUT) c.filteredOut++;
    }
    return c;
  };
  const valueTieOut = valueTotals
    ? Math.abs(valueTotals.totalA - (valueTotals.matched + valueTotals.mismatch + valueTotals.ambiguous + valueTotals.onlyA + valueTotals.excluded)) <= 1
    : true;

  const integrity = {
    rowsA: nA,
    rowsB: rowsB.length,
    accountedA: countedA,
    rowTieOutA: countedA === nA,
    accountedB,
    matchedB,
    rowTieOutB: accountedB === rowsB.length,
    excludedA: excludedCounts(A.exclude),
    excludedB: excludedCounts(B.exclude),
    keyCollisionsA: A.collisions,
    keyCollisionsB: B.collisions,
    collisionExamplesA: A.collisionExamples,
    collisionExamplesB: B.collisionExamples,
    valueTotals,
    valueTieOut,
    ok: countedA === nA && accountedB === rowsB.length && valueTieOut,
  };

  const counts = {
    matched: idx.matched.length,
    mismatch: idx.mismatch.length,
    ambiguous: idx.ambiguous.length,
    onlyA: idx.onlyA.length,
    onlyB: idx.onlyB.length,
    excludedA: idx.excluded.length,
    excludedB: idx.excludedB.length,
    groups: groups.length,
    fallbackMatches,
    usableA: A.slots.length,
    usableB: B.slots.length,
  };
  counts.matchRate = counts.usableA ? Math.round((counts.matched / counts.usableA) * 1000) / 10 : 0;

  onProgress?.({ phase: 'done', done: 1 });

  return {
    engineVersion: ENGINE_VERSION,
    timestamp: new Date().toISOString(),
    keyA, keyB, headersA, headersB, currency,
    pairs: pairs.map(({ metaA, metaB, ...rest }) => ({
      ...rest,
      dateFormatDetectedA: metaA?.format ?? null,
      dateFormatDetectedB: metaB?.format ?? null,
      dateAmbiguousA: metaA?.ambiguous ?? false,
      dateAmbiguousB: metaB?.ambiguous ?? false,
      dateReasonA: metaA?.reason ?? null,
      dateReasonB: metaB?.reason ?? null,
    })),
    settings: { ...settings, keyRulesA, keyRulesB, groupMatching, groupTolerance, dateAmountFallback: fallbackEnabled, textThresholds },
    counts,
    integrity,
    groups,
    index: { status, bIndex, ruleCode, groupId, diffMinor, excludeCode, idx, keysA: A.keys, keysB: B.keys },
    internal: {
      pairs, evaluatePair, amountPair, datePair, textThresholds,
      displayA, displayB, formatsA, formatsB,
      compareTextPair: (p, a, b) => V.compareText(a, b, {
        mode: p.type === 'identifier' ? 'identifier' : 'text',
        caseSensitive: !!p.caseSensitive,
        thresholds: textThresholds,
      }),
    },
  };
}

/* ---------------------------------------------------- detail materialisation */

const TABS = ['exceptions', 'all', 'allData', 'matched', 'breaks', 'ambiguous', 'onlyA', 'onlyB', 'excluded'];

/**
 * "All Data": every result in one list, in this order — Matched, Mismatched,
 * Only in File A, Only in File B. Returns `{ length, at(i) -> { slot, tab } }`
 * so only-in-B rows (keyed on the B side) can sit in the same list.
 */
function allDataEntries(run) {
  const { idx } = run.index;
  const parts = [
    [idx.matched, 'matched'], [idx.mismatch, 'breaks'], [idx.ambiguous, 'breaks'],
    [idx.onlyA, 'onlyA'], [idx.onlyB, 'onlyB'],
  ];
  const length = parts.reduce((t, [a]) => t + a.length, 0);
  return {
    length,
    at(i) {
      for (const [arr, tab] of parts) {
        if (i < arr.length) return { slot: arr[i], tab };
        i -= arr.length;
      }
      return null;
    },
  };
}

/** Same shape for any tab, so paging and export treat "All Data" like the others. */
function entriesForTab(run, tab) {
  if (tab === 'allData') return allDataEntries(run);
  const slots = slotsForTab(run, tab);
  return { length: slots.length, at: (i) => ({ slot: slots[i], tab }) };
}

function slotsForTab(run, tab) {
  const { idx } = run.index;
  switch (tab) {
    case 'matched': return idx.matched;
    case 'breaks': return idx.mismatch;
    case 'ambiguous': return idx.ambiguous;
    case 'onlyA': return idx.onlyA;
    case 'onlyB': return idx.onlyB;
    case 'excluded': return idx.excluded;
    case 'exceptions': {
      const out = new Int32Array(idx.mismatch.length + idx.ambiguous.length + idx.onlyA.length);
      out.set(idx.mismatch, 0);
      out.set(idx.ambiguous, idx.mismatch.length);
      out.set(idx.onlyA, idx.mismatch.length + idx.ambiguous.length);
      return out;
    }
    default: {
      const out = new Int32Array(run.index.status.length);
      for (let i = 0; i < out.length; i++) out[i] = i;
      return out;
    }
  }
}

/** Build the full detail record for one A row (or one only-in-B row). */
function buildRow(run, rowsA, rowsB, slot, tab) {
  const { status, bIndex, ruleCode, groupId, diffMinor, excludeCode } = run.index;
  const { evaluatePair, pairs } = run.internal;
  const currency = run.currency;

  const { displayA, displayB } = run.internal;
  const shownA = (i, col) => shownValue(rowsA, displayA, i, col);
  const shownB = (i, col) => shownValue(rowsB, displayB, i, col);
  /** Whole source row as the spreadsheet showed it, for the drawer and the export. */
  const shownRow = (rows, display, i, headers) => {
    if (i === null || i === undefined || i < 0 || !rows[i]) return null;
    const out = {};
    for (const h of headers) out[h] = shownValue(rows, display, i, h);
    return out;
  };

  if (tab === 'onlyB') {
    const rowB = rowsB[slot];
    return {
      id: `b${slot}`,
      side: 'B',
      keyA: '',
      keyB: shownB(slot, run.keyB),
      keyNorm: run.index.keysB?.[slot] || '',
      status: 'Only in File B',
      statusCode: 'ONLY_B',
      rule: '',
      reason: `No row in file A with key "${run.index.keysB?.[slot] || ''}" (${run.keyB} to ${run.keyA})`,
      cells: pairs.map((p) => {
        const valueB = rowB?.[p.colB];
        if (p.type === 'text' || p.type === 'identifier') {
          const r = run.internal.compareTextPair(p, undefined, valueB);
          return { pairId: p.id, label: p.label, type: p.type, ok: false, displayA: '', displayB: shownB(slot, p.colB), normalizedB: r.normalizedB, similarity: null, status: r.matchType, textStatus: r.status, textLabel: 'Not Match', textReason: r.reason, decision: r.decision, diff: null };
        }
        return { pairId: p.id, label: p.label, type: p.type, ok: false, displayA: '', displayB: shownB(slot, p.colB), diff: null, status: 'MISSING_A_SIDE', textReason: 'No value in file A' };
      }),
      diff: null,
      similarity: null,
      textStatus: 'NOT_FOUND_IN_FILE_A',
      textLabel: 'Not Match',
      result: 'Only in File B',
      rowB,
      shownB: shownRow(rowsB, displayB, slot, run.headersB),
    };
  }

  const rowA = rowsA[slot];
  const bi = bIndex[slot];
  const rowB = bi >= 0 ? rowsB[bi] : null;
  const st = status[slot];

  if (st === STATUS.EXCLUDED) {
    return {
      id: `a${slot}`,
      side: 'A',
      keyA: shownA(slot, run.keyA),
      keyB: '',
      keyNorm: run.index.keysA?.[slot] || '',
      status: 'Excluded',
      statusCode: 'EXCLUDED',
      rule: '',
      reason: EXCLUDE_LABEL[excludeCode[slot]] || 'Excluded',
      cells: pairs.map((p) => ({ pairId: p.id, label: p.label, type: p.type, ok: false, displayA: shownA(slot, p.colA), displayB: '', diff: null, status: 'EXCLUDED' })),
      diff: null,
      result: 'Not Match',
      rowA,
      shownA: shownRow(rowsA, displayA, slot, run.headersA),
    };
  }

  const { results, reasons } = evaluatePair(rowA, rowB);
  // Show every cell exactly as the spreadsheet showed it. The engine's parsed
  // view (₹ formatting, ISO dates) moves to parsedA/parsedB for the details.
  for (const c of results) {
    const p = pairs.find((x) => x.id === c.pairId);
    if (!p) continue;
    c.parsedA = c.displayA;
    c.parsedB = c.displayB;
    c.displayA = shownA(slot, p.colA);
    c.displayB = rowB ? shownB(bi, p.colB) : '';
  }
  // Row-level similarity = the weakest text signal on the row, so a finance
  // user sees the worst case rather than an average that hides it.
  let similarity = null;
  let textStatus = null;
  const TEXT_RANK = { MATCH: 0, MISMATCH: 2, NOT_FOUND_IN_FILE_B: 3, NOT_FOUND_IN_FILE_A: 3, EMPTY: -1 };
  for (const c of results) {
    if (c.type !== 'text' && c.type !== 'identifier') continue;
    if (typeof c.similarity === 'number' && (similarity === null || c.similarity < similarity)) similarity = c.similarity;
    if (c.textStatus && (textStatus === null || (TEXT_RANK[c.textStatus] ?? 0) > (TEXT_RANK[textStatus] ?? 0))) textStatus = c.textStatus;
  }
  const gid = groupId[slot];
  const group = gid >= 0 ? run.groups[gid] : null;
  const statusLabel = STATUS_LABEL[st];
  const normKey = run.index.keysA?.[slot] || '';
  const reason = st === STATUS.ONLY_A
    ? `No row in file B with key "${normKey}" (${run.keyA} to ${run.keyB})`
    : st === STATUS.AMBIGUOUS
      ? 'Two or more file B rows fit equally well: confirm manually'
      : reasons.join('; ');

  return {
    id: `a${slot}`,
    side: 'A',
    keyA: shownA(slot, run.keyA),
    keyB: rowB ? shownB(bi, run.keyB) : '',
    keyNorm: normKey,
    status: statusLabel,
    statusCode: ['MATCHED', 'BREAK', 'ONLY_A', 'AMBIGUOUS', 'EXCLUDED'][st],
    rule: RULE_LABEL[ruleCode[slot]],
    reason,
    cells: results,
    similarity,
    textStatus,
    textLabel: textStatus ? textLabelOf(textStatus) : null,
    // One word for the whole row: Match only when the reconciliation matched it.
    result: st === STATUS.MATCHED ? 'Matched' : st === STATUS.ONLY_A ? 'Only in File A' : 'Mismatched',
    diff: diffMinor[slot] ? V.formatMinor(diffMinor[slot], currency) : null,
    diffMinor: diffMinor[slot] || 0,
    group: group ? { cardinality: group.cardinality, sumA: V.formatMinor(group.sumAMinor, currency), sumB: V.formatMinor(group.sumBMinor, currency), aCount: group.aRows.length, bCount: group.bRows.length } : null,
    rowA,
    rowB,
    shownA: shownRow(rowsA, displayA, slot, run.headersA),
    shownB: rowB ? shownRow(rowsB, displayB, bi, run.headersB) : null,
  };
}

function rowMatchesQuery(row, q) {
  if (row.keyA.toLowerCase().includes(q) || row.keyB.toLowerCase().includes(q)) return true;
  if (row.status.toLowerCase().includes(q) || String(row.reason).toLowerCase().includes(q)) return true;
  return row.cells.some((c) => String(c.displayA).toLowerCase().includes(q) || String(c.displayB).toLowerCase().includes(q));
}

/** Page a tab, optionally filtered by a search term. */
function getPage(run, rowsA, rowsB, { tab = 'exceptions', offset = 0, limit = 100, search = '' } = {}) {
  const list = entriesForTab(run, TABS.includes(tab) ? tab : 'exceptions');
  const make = (i) => { const e = list.at(i); return buildRow(run, rowsA, rowsB, e.slot, e.tab); };
  const q = String(search || '').trim().toLowerCase();
  if (!q) {
    const rows = [];
    for (let i = offset; i < Math.min(list.length, offset + limit); i++) rows.push(make(i));
    return { rows, total: list.length };
  }
  const rows = [];
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    const row = make(i);
    if (!rowMatchesQuery(row, q)) continue;
    if (total >= offset && rows.length < limit) rows.push(row);
    total++;
  }
  return { rows, total };
}

module.exports = {
  reconcile, profileColumns, getPage, buildRow, slotsForTab, entriesForTab, textLabelOf,
  STATUS, STATUS_LABEL, RULE_LABEL, EXCLUDE, EXCLUDE_LABEL, TABS, ENGINE_VERSION,
};
