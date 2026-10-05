'use strict';
/**
 * Automatic reconciliation plan.
 *
 * Given both parsed files, this module decides — from the data, not from a
 * guess — which columns are the matching key, what has to be stripped from
 * those keys (OD, JV-CF-, leading zeros …), and which remaining columns pair up
 * as amount / date / party / text rules.
 *
 * Rules of the house, same as the comparison engine:
 *   - every decision is derived from counted evidence (how many keys actually
 *     meet on the other side), never from a hardcoded score;
 *   - nothing mutates the source values: the key rules are transformations the
 *     engine applies at compare time, exactly as a user would have set them;
 *   - the cheapest test runs first, and a transformation is only kept when it
 *     provably matches more rows than leaving it off;
 *   - every choice comes back with a plain-English reason and the numbers
 *     behind it, so a reviewer can disagree with it.
 */

const V = require('./values.cjs');
const T = require('./text.cjs');

/** How many rows are sampled when scoring candidates. Bounded for 500k files. */
const SAMPLE = 4000;
/** A key column has to be nearly unique and nearly always filled. */
const MIN_UNIQUE_RATIO = 0.7;
const MIN_FILL_RATIO = 0.6;
/** A column pair needs at least this share of A keys present in B to be a key. */
const MIN_KEY_OVERLAP = 0.2;
/** Header-name similarity floor before two columns are paired automatically. */
const MIN_HEADER_SIMILARITY = 28;

/* ------------------------------------------------------------ header naming */

/** Header words that name the same thing on an order sheet and in a ledger. */
const SYNONYMS = [
  // Order matters: "Order Amount" is an amount, not a key, so the specific
  // money/date/party wording is tested before the generic document wording.
  ['amount', /\b(amount|amt|value|total|net|gross|debit|credit|dr|cr|balance|payable|receivable|taxable)\b/i],
  ['date', /\b(date|dt|dated|posting|voucher\s*date|invoice\s*date|entry\s*date)\b/i],
  ['party', /\b(party|customer|client|vendor|supplier|ledger|account|buyer|seller|name|company|firm)\b/i],
  ['narration', /\b(narration|particulars|description|remark|remarks|details|note|notes|memo)\b/i],
  ['qty', /\b(qty|quantity|units|pcs|nos)\b/i],
  ['tax', /\b(gst|tax|igst|cgst|sgst|tds|vat|cess)\b/i],
  ['key', /\b(order\s*(id|no|number|ref)?|voucher\s*(no|number|ref)?|invoice\s*(no|number)?|bill\s*(no|number)?|txn|transaction|reference|ref|doc(ument)?\s*(no|number)?|challan|code|po|so|id)\b/i],
];

/** Which business concept a header reads like, or null when nothing matches. */
function conceptOf(header) {
  const h = String(header || '').replace(/[_\-.]+/g, ' ');
  for (const [name, re] of SYNONYMS) if (re.test(h)) return name;
  return null;
}

/** 0..100 similarity between two header names, ignoring case and separators. */
function headerSimilarity(a, b) {
  const r = T.compareText(String(a || '').replace(/[_\-.]+/g, ' '), String(b || '').replace(/[_\-.]+/g, ' '), { mode: 'text' });
  return r.similarity ?? 0;
}

/* -------------------------------------------------------------- key sampling */

/** Up to SAMPLE raw values of a column, blanks skipped, in sheet order. */
function sampleValues(rows, column, limit = SAMPLE) {
  const out = [];
  const step = rows.length > limit ? Math.ceil(rows.length / limit) : 1;
  for (let i = 0; i < rows.length && out.length < limit; i += step) {
    const v = rows[i]?.[column];
    if (!V.isBlank(v)) out.push(v);
  }
  return out;
}

/**
 * Longest leading run shared by at least `share` of the sampled values, cut
 * back to the last letter and required to leave digits behind. "OD-1013",
 * "OD-1014" → "OD-"; "JV-CF-9001" → "JV-CF-"; plain "1013" → null.
 */
function detectPrefix(values, share = 0.9) {
  const strings = values.map((v) => String(v).trim()).filter(Boolean);
  if (strings.length < 5) return null;
  const need = Math.ceil(strings.length * share);

  // Grow the candidate one character at a time while enough values still share it.
  let best = '';
  const first = strings[0];
  for (let len = 1; len <= Math.min(first.length - 1, 12); len++) {
    const candidate = first.slice(0, len);
    const upper = candidate.toUpperCase();
    let count = 0;
    for (const s of strings) if (s.toUpperCase().startsWith(upper)) count++;
    if (count < need) break;
    best = candidate;
  }
  if (!best) return null;

  // A prefix must start with a letter, end at a letter or separator, and leave
  // something behind — stripping "104" off "1045" would destroy the identity.
  if (!/^[A-Za-z]/.test(best)) return null;
  // The shared run often eats into the number itself ("OD-10" out of OD-1013).
  // Digits carry identity, so cut back to the last letter or separator.
  best = best.replace(/\d+$/, '');
  if (!best) return null;
  const trimmed = best.replace(/[^A-Za-z0-9]+$/, '');
  if (!trimmed) return null;
  if (!/[A-Za-z]/.test(trimmed)) return null;

  const withSeparators = best;                      // keep "OD-" if that is shared
  const remainderOk = strings.every((s) => s.length > withSeparators.length);
  return remainderOk ? withSeparators : trimmed;
}

/** Normalised key set for a column under one rule set, plus blank/dupe counts. */
function keySet(rows, column, rules, limit = SAMPLE) {
  const set = new Set();
  let filled = 0;
  let blank = 0;
  const step = rows.length > limit ? Math.ceil(rows.length / limit) : 1;
  let seen = 0;
  for (let i = 0; i < rows.length; i += step) {
    const raw = rows[i]?.[column];
    seen++;
    if (V.isBlank(raw)) { blank++; continue; }
    const { key, empty } = V.normalizeKey(raw, rules);
    if (empty) { blank++; continue; }
    filled++;
    set.add(key);
  }
  return { set, filled, blank, seen };
}

/* ----------------------------------------------------------- key candidates */

/** Columns that could be a matching key, best first. */
function keyCandidates(rows, profile) {
  const total = Math.max(rows.length, 1);
  return profile
    .map((p) => {
      const filled = p.filled ?? (total - (p.blanks || 0));
      const distinct = p.distinctSample ?? 0;
      const uniqueRatio = filled ? Math.min(distinct / filled, 1) : 0;
      const fillRatio = filled / total;
      const concept = conceptOf(p.name);
      // Name is only a tie-breaker; the overlap test below decides.
      const nameBonus = concept === 'key' ? 0.35 : 0;
      const typeBonus = p.type === 'identifier' ? 0.2 : 0;
      const wholeNumbers = (p.samples || []).length > 0
        && (p.samples || []).every((v) => /^\d+$/.test(String(v).trim()));
      // A money column is never the key — unless it is really a plain voucher
      // number that happens to parse as a number and is not named like money.
      const usableType = p.type === 'date' ? false
        : p.type === 'amount' ? (concept !== 'amount' && concept !== 'tax' && concept !== 'qty' && wholeNumbers && uniqueRatio >= 0.95)
          : true;
      return { name: p.name, type: p.type, concept, usableType, uniqueRatio, fillRatio, score: uniqueRatio + fillRatio * 0.3 + nameBonus + typeBonus };
    })
    .filter((c) => c.usableType && c.fillRatio >= MIN_FILL_RATIO && c.uniqueRatio >= MIN_UNIQUE_RATIO)
    .sort((x, y) => y.score - x.score)
    .slice(0, 5);
}

const BASE_RULES = { caseFold: true, stripSeparators: true, prefix: '', extract: '', dropLeadingZeros: false, collapseTrailingZeros: true };

/**
 * Rule variants worth testing for one column: plain, prefix stripped, leading
 * zeros dropped, and both. Cheapest first; the winner is whichever matches more.
 */
function ruleVariants(rows, column) {
  const samples = sampleValues(rows, column, 800);
  const prefix = detectPrefix(samples);
  const hasLeadingZeros = samples.some((v) => /^0\d/.test(String(v).trim()));
  const variants = [{ rules: { ...BASE_RULES }, label: 'case and punctuation ignored' }];
  if (prefix) variants.push({ rules: { ...BASE_RULES, prefix }, label: `prefix “${prefix}” removed`, prefix });
  if (hasLeadingZeros) variants.push({ rules: { ...BASE_RULES, dropLeadingZeros: true }, label: 'leading zeros dropped' });
  if (prefix && hasLeadingZeros) {
    variants.push({ rules: { ...BASE_RULES, prefix, dropLeadingZeros: true }, label: `prefix “${prefix}” removed and leading zeros dropped`, prefix });
  }
  return variants;
}

/**
 * Pick the key columns and their clean-up rules by counting how many keys
 * actually meet on the other side. No preference is hardcoded: the pair with
 * the most matched keys wins, and a transformation is only kept when it beats
 * leaving it off.
 */
function chooseKey(rowsA, profileA, rowsB, profileB) {
  const candA = keyCandidates(rowsA, profileA);
  const candB = keyCandidates(rowsB, profileB);
  if (!candA.length || !candB.length) return null;

  const variantsA = new Map(candA.map((c) => [c.name, ruleVariants(rowsA, c.name)]));
  const variantsB = new Map(candB.map((c) => [c.name, ruleVariants(rowsB, c.name)]));
  const setsA = new Map();
  const setsB = new Map();
  for (const c of candA) for (const v of variantsA.get(c.name)) setsA.set(`${c.name}|${v.label}`, keySet(rowsA, c.name, v.rules));
  for (const c of candB) for (const v of variantsB.get(c.name)) setsB.set(`${c.name}|${v.label}`, keySet(rowsB, c.name, v.rules));

  let best = null;
  for (const a of candA) {
    for (const b of candB) {
      for (const va of variantsA.get(a.name)) {
        for (const vb of variantsB.get(b.name)) {
          const ka = setsA.get(`${a.name}|${va.label}`);
          const kb = setsB.get(`${b.name}|${vb.label}`);
          if (!ka.set.size || !kb.set.size) continue;
          let matched = 0;
          for (const k of ka.set) if (kb.set.has(k)) matched++;
          const coverage = matched / Math.max(Math.min(ka.set.size, kb.set.size), 1);
          const transforms = (va.prefix ? 1 : 0) + (vb.prefix ? 1 : 0)
            + (va.rules.dropLeadingZeros ? 1 : 0) + (vb.rules.dropLeadingZeros ? 1 : 0);
          const nameScore = headerSimilarity(a.name, b.name) / 100;
          // Matched keys decide. Among pairs that match equally well, a real
          // document reference beats a name column, then fewer transformations,
          // then the closer-named and more unique pair — never the other way round.
          const keyish = (conceptOf(a.name) === 'key' ? 1 : 0) + (conceptOf(b.name) === 'key' ? 1 : 0);
          const score = matched * 1000 - transforms * 5 + keyish * 20 + nameScore * 3 + (a.uniqueRatio + b.uniqueRatio);
          if (!best || score > best.score) {
            best = {
              score, matched, coverage,
              keyA: a.name, keyB: b.name,
              keyRulesA: va.rules, keyRulesB: vb.rules,
              labelA: va.label, labelB: vb.label,
              prefixA: va.prefix || '', prefixB: vb.prefix || '',
              sampledA: ka.set.size, sampledB: kb.set.size,
              uniqueA: a.uniqueRatio, uniqueB: b.uniqueRatio,
            };
          }
        }
      }
    }
  }
  if (!best || best.coverage < MIN_KEY_OVERLAP) {
    // Nothing overlaps well. Fall back to the best-named candidate on each side
    // so the run still happens, and say so in the decision log.
    const a = candA[0];
    const b = candB[0];
    return {
      keyA: a.name, keyB: b.name,
      keyRulesA: { ...BASE_RULES }, keyRulesB: { ...BASE_RULES },
      matched: best?.matched ?? 0, coverage: best?.coverage ?? 0,
      labelA: 'case and punctuation ignored', labelB: 'case and punctuation ignored',
      prefixA: '', prefixB: '', weak: true,
      sampledA: best?.sampledA ?? 0, sampledB: best?.sampledB ?? 0,
    };
  }
  return best;
}

/* --------------------------------------------------------------- field pairs */

const PAIR_DEFAULTS = {
  absTol: 0, pctTol: 0, dateBefore: 0, dateAfter: 0,
  dateFormatA: 'auto', dateFormatB: 'auto',
  ignoreSign: false, caseSensitive: false, required: true,
};

/** Comparison type for a pair of detected column types. */
function pairType(tA, tB) {
  if (tA === 'amount' && tB === 'amount') return 'amount';
  if (tA === 'date' && tB === 'date') return 'date';
  if (tA === 'identifier' || tB === 'identifier') return 'identifier';
  return 'text';
}

/**
 * Pair the remaining columns greedily: same detected type, then the closest
 * header meaning, then the closest header spelling. One column is used once.
 */
function choosePairs(profileA, profileB, keyA, keyB) {
  const left = profileA.filter((p) => p.name !== keyA && p.type !== 'unknown');
  const right = profileB.filter((p) => p.name !== keyB && p.type !== 'unknown');
  const scored = [];

  for (const a of left) {
    for (const b of right) {
      const type = pairType(a.type, b.type);
      const sameType = a.type === b.type;
      const cA = conceptOf(a.name);
      const cB = conceptOf(b.name);
      const nameSim = headerSimilarity(a.name, b.name);
      // A shared concept ("amount" vs "value") counts more than spelling.
      const conceptScore = cA && cA === cB ? 60 : 0;
      if (!sameType && !(a.type === 'amount' && b.type === 'amount')) {
        // Different detected types only pair when both read like the same thing
        // and neither is a number/date mix-up.
        if (!conceptScore || a.type === 'date' || b.type === 'date') continue;
      }
      const total = conceptScore + nameSim + (sameType ? 25 : 0);
      if (total < MIN_HEADER_SIMILARITY) continue;
      scored.push({ a: a.name, b: b.name, type, total, nameSim, conceptScore, sameType, concept: cA === cB ? cA : null });
    }
  }

  scored.sort((x, y) => y.total - x.total);
  const usedA = new Set();
  const usedB = new Set();
  const pairs = [];
  const decisions = [];
  for (const s of scored) {
    if (usedA.has(s.a) || usedB.has(s.b)) continue;
    usedA.add(s.a); usedB.add(s.b);
    pairs.push({
      ...PAIR_DEFAULTS,
      id: `p${pairs.length + 1}`,
      colA: s.a, colB: s.b,
      type: s.type === 'text' ? 'auto' : s.type,
    });
    decisions.push({
      what: `${s.a} and ${s.b}`,
      chose: s.type === 'auto' ? 'text' : s.type,
      why: s.concept
        ? `both columns have ${s.type === 'amount' ? 'amounts' : s.type === 'date' ? 'dates' : 'the same kind of text'}`
        : `both columns have the same kind of data and similar names`,
    });
  }
  return { pairs, decisions };
}

/* ------------------------------------------------------------------- planner */

/**
 * Build the whole plan. `overrides` is anything the user has already decided —
 * their values always win, and the planner only fills the gaps.
 */
function buildAutoPlan({ rowsA, rowsB, profileA, profileB, overrides = {} }) {
  const decisions = [];
  const key = chooseKey(rowsA, profileA, rowsB, profileB);
  if (!key) throw new Error('Could not find an Order ID column in these two files.');

  const keyA = overrides.keyA || key.keyA;
  const keyB = overrides.keyB || key.keyB;
  const userChoseKey = !!(overrides.keyA || overrides.keyB);

  const keyRulesA = overrides.keyRulesA || key.keyRulesA;
  const keyRulesB = overrides.keyRulesB || key.keyRulesB;

  decisions.push({
    what: 'Order ID columns',
    chose: `${keyA} and ${keyB}`,
    why: userChoseKey
      ? 'you picked these columns'
      : key.weak
        ? `the IDs did not match well, so the best ID column in each file was used (${key.matched} matched)`
        : `${key.matched} of ${Math.min(key.sampledA, key.sampledB)} checked IDs are in both files`,
  });

  if (!overrides.keyRulesA && (key.prefixA || keyRulesA.dropLeadingZeros)) {
    decisions.push({ what: `Clean-up in ${keyA}`, chose: key.labelA, why: 'this finds more matching orders' });
  }
  if (!overrides.keyRulesB && (key.prefixB || keyRulesB.dropLeadingZeros)) {
    decisions.push({ what: `Clean-up in ${keyB}`, chose: key.labelB, why: 'this finds more matching orders' });
  }

  let pairs = overrides.pairs;
  if (!pairs || !pairs.length) {
    const chosen = choosePairs(profileA, profileB, keyA, keyB);
    pairs = chosen.pairs;
    for (const d of chosen.decisions) decisions.push({ what: `Compare ${d.what}`, chose: d.chose, why: d.why });
    if (!pairs.length) decisions.push({ what: 'Compare', chose: 'nothing', why: 'no similar columns were found in the two files' });
  } else {
    decisions.push({ what: 'Compare', chose: `${pairs.length} field${pairs.length === 1 ? '' : 's'}`, why: 'your saved settings were used' });
  }

  return {
    keyA, keyB, keyRulesA, keyRulesB, pairs,
    evidence: {
      matchedKeys: key.matched,
      sampledKeysA: key.sampledA,
      sampledKeysB: key.sampledB,
      coverage: Math.round((key.coverage || 0) * 1000) / 10,
      prefixA: key.prefixA || '',
      prefixB: key.prefixB || '',
      weak: !!key.weak,
    },
    decisions,
  };
}

module.exports = {
  buildAutoPlan,
  chooseKey,
  detectPrefix,
  conceptOf,
  headerSimilarity,
  keyCandidates,
  SAMPLE,
};
