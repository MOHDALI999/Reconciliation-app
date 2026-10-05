'use strict';
/**
 * Text comparison engine tests.
 *
 * These tests never assert a hard-coded fuzzy percentage for an inexact pair.
 * They assert what the specification actually requires: that the score is
 * produced by the algorithm, sits in a sensible band, is deterministic, is
 * symmetric where it should be, and that classification never rewrites it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../core/text.cjs');
const V = require('../core/values.cjs');
const { reconcile, buildRow, slotsForTab } = require('../core/engine.cjs');

const sim = (a, b, opts) => T.compareText(a, b, opts);

/* ------------------------------------------------------- normalisation rules */

test('normalisation folds case, spacing, punctuation and separators only', () => {
  assert.equal(T.normalizeText('  ABC   TRADERS  PVT. LTD. '), 'abc traders pvt ltd');
  assert.equal(T.normalizeText('abc traders pvt ltd'), 'abc traders pvt ltd');
  assert.equal(T.normalizeText('ABC-TRADERS/PVT_LTD'), 'abc traders pvt ltd');
  assert.equal(T.normalizeText('#INV-001'), 'inv 001');
});

test('normalisation never changes the identity of a value', () => {
  // digits survive, abbreviations are not expanded, words are not stemmed
  assert.equal(T.normalizeText('INV 1001'), 'inv 1001');
  assert.notEqual(T.normalizeText('INV 1001'), T.normalizeText('INV 1002'));
  assert.notEqual(T.normalizeText('PVT'), T.normalizeText('PRIVATE'));
  assert.notEqual(T.normalizeText('TRADERS'), T.normalizeText('TRADER'));
});

test('case sensitive mode keeps case during normalisation', () => {
  assert.equal(T.normalizeText('ABC Traders', { caseSensitive: true }), 'ABC Traders');
  assert.equal(sim('ABC', 'abc', { caseSensitive: true }).status, 'MISMATCH');
});

test('original values are never modified', () => {
  const r = sim('  ABC TRADERS PVT. LTD. ', 'abc traders pvt ltd');
  assert.equal(r.originalA, '  ABC TRADERS PVT. LTD. ');
  assert.equal(r.originalB, 'abc traders pvt ltd');
});

/* ------------------------------------------------------------- spec §15 cases */

test('identical values score 100 and MATCH', () => {
  const r = sim('ABC', 'ABC');
  assert.equal(r.similarity, 100);
  assert.equal(r.status, 'MATCH');
  assert.equal(r.matchType, 'EXACT');
});

test('case-only difference scores 100 after normalisation', () => {
  const r = sim('ABC', 'abc');
  assert.equal(r.similarity, 100);
  assert.equal(r.status, 'MATCH');
  assert.equal(r.matchType, 'NORMALIZED_EXACT');
});

test('punctuation and spacing differences score 100 after normalisation', () => {
  const a = sim('ABC TRADERS PVT. LTD.', 'abc traders pvt ltd');
  assert.equal(a.similarity, 100);
  assert.equal(a.status, 'MATCH');
  const b = sim('ABC    TRADERS', 'ABC TRADERS');
  assert.equal(b.similarity, 100);
  const c = sim('A.B.C. Traders, Mumbai', 'ABC Traders Mumbai');
  assert.notEqual(c.matchType, 'NORMALIZED_EXACT', 'A.B.C. splits into letters — not silently equal');
  assert.ok(c.similarity > 0 && c.similarity < 100);
});

test('singular/plural word difference produces a high calculated score', () => {
  const r = sim('ABC TRADERS', 'ABC TRADER');
  assert.ok(r.similarity > 85 && r.similarity < 100, `expected a high sub-100 score, got ${r.similarity}`);
  assert.equal(r.status, 'MATCH', 'above the 50% line is a Match');
  assert.equal(r.matchType, 'FUZZY', 'but it is still recorded as an approximate, not exact, match');
  assert.match(r.decision, /≥ 50% → Match/);
  // the score came from the signals, not from the status
  assert.ok(r.signals.token > 85);
  assert.ok(r.signals.levenshtein > 85);
});

test('token reordering scores high without being called identical', () => {
  const r = sim('ABC TRADERS MUMBAI', 'MUMBAI ABC TRADERS');
  assert.equal(r.signals.token, 100, 'all tokens align');
  assert.ok(r.similarity > 80 && r.similarity < 100, `got ${r.similarity}`);
  assert.equal(r.matchType, 'TOKEN_REORDER');
  assert.equal(r.status, 'MATCH');
  assert.ok(r.signals.charDirect < r.signals.charSorted, 'direct order disagrees, sorted order agrees');
});

test('unrelated names score low and MISMATCH', () => {
  const r = sim('ABC TRADERS', 'XYZ ENTERPRISES');
  assert.ok(r.similarity < 40, `expected a low score, got ${r.similarity}`);
  assert.equal(r.status, 'MISMATCH');
});

test('similar-but-different companies stay separated', () => {
  // Spec §7: high similarity is not identity.
  const r = sim('ABC TRADERS', 'ABC TRADING');
  assert.ok(r.similarity < 100, 'never 100 for different words');
  assert.notEqual(r.matchType, 'EXACT');
  assert.notEqual(r.matchType, 'NORMALIZED_EXACT');
  // The 50% rule calls this a Match; the details still say the words differ.
  assert.equal(r.status, 'MATCH');
  assert.match(r.reason, /spelling|words/);
});

test('a shared suffix does not inflate a different company name', () => {
  const shared = sim('ABC TRADERS PVT LTD', 'XYZ ENTERPRISES PVT LTD');
  const bare = sim('ABC TRADERS', 'XYZ ENTERPRISES');
  assert.ok(shared.similarity < 65, `shared "pvt ltd" must not carry the score, got ${shared.similarity}`);
  assert.ok(shared.similarity > bare.similarity, 'but it is still some evidence');
});

/* --------------------------------------------------------- empty and missing */

test('missing values are reported, never fuzzy compared', () => {
  const b = sim('ABC TRADERS', '');
  assert.equal(b.similarity, null);
  assert.equal(b.status, 'NOT_FOUND_IN_FILE_B');
  assert.equal(b.signals, null);

  const a = sim('   ', 'ABC TRADERS');
  assert.equal(a.similarity, null);
  assert.equal(a.status, 'NOT_FOUND_IN_FILE_A');

  const both = sim(null, undefined);
  assert.equal(both.similarity, null);
  assert.equal(both.status, 'EMPTY');
  assert.equal(both.matchType, 'BOTH_EMPTY');
});

/* -------------------------------------------------- score integrity and bounds */

test('every score is a real number inside 0..100', () => {
  const samples = [
    ['ABC', 'ABC'], ['ABC', 'XYZ'], ['a', 'ab'], ['', 'x'],
    ['ABC TRADERS PVT LTD', 'ABC TRADRES PVT LIMITED'],
    ['Reliance Industries Limited', 'RELIANCE INDS LTD'],
    ['ॐ ट्रेडर्स', 'ओम ट्रेडर्स'],
    ['x'.repeat(600), `${'x'.repeat(590)}yyyyyyyyyy`],
  ];
  for (const [a, b] of samples) {
    const r = sim(a, b);
    if (r.similarity === null) continue;
    assert.equal(typeof r.similarity, 'number');
    assert.ok(Number.isFinite(r.similarity));
    assert.ok(r.similarity >= 0 && r.similarity <= 100, `${a} vs ${b} -> ${r.similarity}`);
  }
});

test('scores are deterministic across repeated and reordered runs', () => {
  const pairs = [
    ['ABC TRADERS PVT LTD', 'ABC TRADRES PRIVATE LIMITED'],
    ['Mumbai Steel & Alloys', 'mumbai steel alloys'],
    ['Order 10023 Freight', 'Freight Order 10023'],
  ];
  const first = pairs.map(([a, b]) => sim(a, b).similarity);
  T.resetCaches();
  const second = pairs.map(([a, b]) => sim(a, b).similarity);
  const reversed = [...pairs].reverse().map(([a, b]) => sim(a, b).similarity).reverse();
  assert.deepEqual(second, first, 'same inputs, same outputs, cache cleared');
  assert.deepEqual(reversed, first, 'evaluation order does not matter');
});

test('the score is symmetric', () => {
  for (const [a, b] of [['ABC TRADERS', 'ABC TRADER'], ['Mumbai Steel', 'Steel Mumbai'], ['abcd', 'abxy']]) {
    assert.equal(sim(a, b).similarity, sim(b, a).similarity, `${a} / ${b}`);
  }
});

test('classification never alters the calculated score', () => {
  const strict = sim('ABC TRADERS', 'ABC TRADER', { thresholds: { match: 98 } });
  const loose = sim('ABC TRADERS', 'ABC TRADER', { thresholds: { match: 10 } });
  assert.equal(strict.similarity, loose.similarity, 'thresholds move the status, not the score');
  assert.equal(strict.status, 'MISMATCH');
  assert.equal(loose.status, 'MATCH');
});

test('the 50% rule: at or above is Match, below is Not Match', () => {
  assert.deepEqual(T.resolveThresholds(undefined), { match: 50 });
  assert.deepEqual(T.resolveThresholds({ match: 65 }), { match: 65 });
  assert.deepEqual(T.resolveThresholds({ match: 250 }), { match: 100 }, 'clamped to 0..100');
  assert.deepEqual(T.resolveThresholds({ high: 92, review: 70 }), { match: 50 }, 'legacy bands are ignored, not reinterpreted');

  // Exactly on the line counts as a Match (>=, not >).
  const on = T.compareText('abcd', 'abxy', { thresholds: { match: T.compareText('abcd', 'abxy').similarity } });
  assert.equal(on.status, 'MATCH');
  const above = T.compareText('abcd', 'abxy', { thresholds: { match: on.similarity + 0.01 } });
  assert.equal(above.status, 'MISMATCH');

  // There are only two outcomes for scored text.
  const seen = new Set();
  for (const [a, b] of [['ABC TRADERS', 'ABC TRADER'], ['ABC', 'XYZ'], ['Mumbai Steel', 'Steel Mumbai'], ['Reliance Industries Limited', 'RELIANCE INDS LTD'], ['a', 'ab']]) {
    seen.add(T.compareText(a, b).status);
  }
  assert.deepEqual([...seen].sort(), ['MATCH', 'MISMATCH']);
  assert.equal(T.STATUS_LABEL.MATCH, 'Match');
  assert.equal(T.STATUS_LABEL.MISMATCH, 'Not Match');
});

test('the result explains itself', () => {
  const r = sim('ABC TRADERS PVT. LTD.', 'ABC TRADRES PVT LTD');
  for (const k of ['originalA', 'originalB', 'normalizedA', 'normalizedB', 'similarity', 'status', 'matchType', 'reason']) {
    assert.ok(k in r, `missing ${k}`);
  }
  assert.equal(r.normalizedA, 'abc traders pvt ltd');
  assert.equal(r.normalizedB, 'abc tradres pvt ltd');
  assert.ok(r.reason.length > 5);
  assert.ok(r.signals.tokensExact >= 3, 'reason is backed by real token counts');
});

/* -------------------------------------------------------------- raw algorithms */

test('levenshtein distance is correct', () => {
  assert.equal(T.levenshtein('', ''), 0);
  assert.equal(T.levenshtein('kitten', 'sitting'), 3);
  assert.equal(T.levenshtein('flaw', 'lawn'), 2);
  assert.equal(T.levenshtein('abcdef', 'abcdef'), 0);
  assert.equal(T.levenshtein('prefix-abc-suffix', 'prefix-xyz-suffix'), 3);
});

test('jaro-winkler matches known reference values', () => {
  assert.ok(Math.abs(T.jaroWinkler('MARTHA', 'MARHTA') - 0.9611) < 0.001);
  assert.ok(Math.abs(T.jaroWinkler('DWAYNE', 'DUANE') - 0.84) < 0.01);
  assert.equal(T.jaroWinkler('abc', 'abc'), 1);
});

test('token similarity is order independent and length weighted', () => {
  const a = T.tokenSimilarity(['abc', 'traders', 'mumbai'], ['mumbai', 'abc', 'traders']);
  assert.equal(a.score, 1);
  assert.equal(a.exact, 3);
  const b = T.tokenSimilarity(['abc', 'traders'], ['abc', 'trader']);
  assert.ok(b.score > 0.85 && b.score < 1);
  assert.equal(b.aligned, 1);
});

/* -------------------------------------------------------------- type detection */

test('identifier columns are detected from values, not names', () => {
  assert.equal(V.inferColumnType(['OD1001', 'OD1002', 'OD1003', 'OD1004']), 'identifier');
  assert.equal(V.inferColumnType(['INV-2024-001', 'INV-2024-002', 'INV-2024-003']), 'identifier');
  assert.equal(V.inferColumnType(['Customer 5', 'Customer 6', 'Customer 7']), 'text');
  assert.equal(V.inferColumnType(['Acme']), 'text', 'too few values to be sure');
  assert.equal(V.inferColumnType(['ABC Traders', 'XYZ Enterprises', 'Mumbai Steel']), 'text');
  assert.equal(V.inferColumnType(['1200.50', '990', '17500.25']), 'amount', 'amounts still win');
  assert.equal(V.inferColumnType(['01/04/2024', '02/04/2024', '03/04/2024']), 'date', 'dates still win');
});

test('identifiers are compared exactly, never approximately', () => {
  const same = sim('#INV-001', 'inv 001', { mode: 'identifier' });
  assert.equal(same.similarity, 100);
  assert.equal(same.status, 'MATCH');

  const near = sim('INV-1001', 'INV-1002', { mode: 'identifier' });
  assert.equal(near.similarity, null, 'no fuzzy score for identifiers');
  assert.equal(near.status, 'MISMATCH');
  assert.equal(near.matchType, 'IDENTIFIER_DIFFERENT');
});

/* --------------------------------------------------------- engine integration */

const H_A = ['Order ID', 'Customer', 'Order Amount'];
const H_B = ['Voucher Ref', 'Party', 'Amount'];
const settings = {
  keyA: 'Order ID', keyB: 'Voucher Ref',
  pairs: [{ id: 'p1', colA: 'Customer', colB: 'Party' }, { id: 'p2', colA: 'Order Amount', colB: 'Amount' }],
};

function runWith(rowsA, rowsB, extra = {}) {
  const run = reconcile({ rowsA, rowsB, headersA: H_A, headersB: H_B, settings: { ...settings, ...extra } });
  return {
    run,
    row: (tab, i) => buildRow(run, rowsA, rowsB, slotsForTab(run, tab)[i], tab),
  };
}

test('the engine runs text comparison automatically with no algorithm choice', () => {
  const rowsA = [{ 'Order ID': 'OD1', Customer: 'ABC TRADERS PVT. LTD.', 'Order Amount': '100' }];
  const rowsB = [{ 'Voucher Ref': 'OD1', Party: 'abc traders pvt ltd', Amount: '100' }];
  const { run, row } = runWith(rowsA, rowsB);
  assert.equal(run.pairs[0].type, 'text');
  assert.equal(run.pairs[0].engine, 'automatic text engine: normalise, tokens, character similarity');
  assert.equal(run.counts.matched, 1, 'punctuation-only difference is a match');

  const r = row('matched', 0);
  const cell = r.cells[0];
  assert.equal(cell.similarity, 100);
  assert.equal(cell.textStatus, 'MATCH');
  assert.equal(cell.normalizedA, 'abc traders pvt ltd');
  assert.equal(r.similarity, 100);
});

test('text at or above 50% is a Match; below 50% is Not Match and breaks the row', () => {
  const rowsA = [
    { 'Order ID': 'OD1', Customer: 'ABC TRADERS', 'Order Amount': '100' },
    { 'Order ID': 'OD2', Customer: 'ABC TRADERS', 'Order Amount': '100' },
  ];
  const rowsB = [
    { 'Voucher Ref': 'OD1', Party: 'ABC TRADER', Amount: '100' },
    { 'Voucher Ref': 'OD2', Party: 'Cash Sale', Amount: '100' },
  ];
  const { run, row } = runWith(rowsA, rowsB);
  assert.equal(run.counts.matched, 1);
  assert.equal(run.counts.mismatch, 1);
  const ok = row('matched', 0);
  assert.ok(ok.similarity > 85 && ok.similarity < 100);
  assert.equal(ok.textStatus, 'MATCH');
  assert.equal(ok.textLabel, 'Match');
  assert.equal(ok.result, 'Matched');
  assert.equal(ok.cells[0].displayA, 'ABC TRADERS', 'original value, untouched');
  const bad = row('breaks', 0);
  assert.ok(bad.similarity < 50);
  assert.equal(bad.textStatus, 'MISMATCH');
  assert.equal(bad.textLabel, 'Not Match');
  assert.equal(bad.result, 'Mismatched');
  assert.match(bad.reason, /similar/i);
  assert.match(bad.cells[0].decision, /< 50% → Not Match/);
});

test('the match line is configurable per run', () => {
  const rowsA = [{ 'Order ID': 'OD1', Customer: 'ABC TRADERS', 'Order Amount': '100' }];
  const rowsB = [{ 'Voucher Ref': 'OD1', Party: 'ABC TRADER', Amount: '100' }];
  const strict = runWith(rowsA, rowsB, { textThresholds: { match: 99 } });
  assert.equal(strict.run.counts.mismatch, 1, 'a 99% line turns a 94% pair into Not Match');
  assert.equal(strict.row('breaks', 0).textLabel, 'Not Match');
});

test('existing amount and date logic is untouched by the text engine', () => {
  const rowsA = [
    { 'Order ID': 'OD1', Customer: 'Acme', 'Order Amount': '1,200.50' },
    { 'Order ID': 'OD2', Customer: 'Acme', 'Order Amount': '900.00' },
  ];
  const rowsB = [
    { 'Voucher Ref': 'OD1', Party: 'Acme', Amount: '1200.50' },
    { 'Voucher Ref': 'OD2', Party: 'Acme', Amount: '900.05' },
  ];
  const { run } = runWith(rowsA, rowsB);
  assert.equal(run.pairs[1].type, 'amount');
  assert.equal(run.counts.matched, 1);
  assert.equal(run.counts.mismatch, 1, 'a 5 paise amount break is still a break');

  const tolerated = reconcile({
    rowsA, rowsB, headersA: H_A, headersB: H_B,
    settings: { ...settings, pairs: [settings.pairs[0], { ...settings.pairs[1], absTol: 0.05 }] },
  });
  assert.equal(tolerated.counts.matched, 2, 'amount tolerance still works');
});

test('only-in-B rows explain the missing A side', () => {
  const rowsA = [{ 'Order ID': 'OD1', Customer: 'Acme', 'Order Amount': '100' }];
  const rowsB = [
    { 'Voucher Ref': 'OD1', Party: 'Acme', Amount: '100' },
    { 'Voucher Ref': 'OD9', Party: 'Beta Corp', Amount: '250' },
  ];
  const { run, row } = runWith(rowsA, rowsB);
  assert.equal(run.counts.onlyB, 1);
  const r = row('onlyB', 0);
  assert.equal(r.cells[0].textStatus, 'NOT_FOUND_IN_FILE_A');
  assert.equal(r.cells[0].similarity, null);
});

test('both sides tie out honestly', () => {
  const rowsA = [
    { 'Order ID': 'OD1', Customer: 'Acme', 'Order Amount': '100' },
    { 'Order ID': 'OD2', Customer: 'Acme', 'Order Amount': '100' },
  ];
  const rowsB = [
    { 'Voucher Ref': 'OD1', Party: 'Acme', Amount: '100' },
    { 'Voucher Ref': 'OD8', Party: 'Acme', Amount: '100' },
    { 'Voucher Ref': 'OD9', Party: 'Acme', Amount: '100' },
  ];
  const { run } = runWith(rowsA, rowsB);
  assert.equal(run.integrity.matchedB, 1);
  assert.equal(run.integrity.accountedB, 3);
  assert.equal(run.integrity.rowTieOutB, true);
  assert.equal(run.integrity.ok, true);
});

test('run settings echo the thresholds actually used', () => {
  const { run } = runWith(
    [{ 'Order ID': 'OD1', Customer: 'Acme', 'Order Amount': '100' }],
    [{ 'Voucher Ref': 'OD1', Party: 'Acme', Amount: '100' }],
    { textThresholds: { match: 65 } },
  );
  assert.deepEqual(run.settings.textThresholds, { match: 65 });
});

test('duplicate keys pick the closest wording, deterministically', () => {
  const rowsA = [{ 'Order ID': 'OD1', Customer: 'Mumbai Steel Traders', 'Order Amount': '100' }];
  const rowsB = [
    { 'Voucher Ref': 'OD1', Party: 'Delhi Cement Works', Amount: '100' },
    { 'Voucher Ref': 'OD1', Party: 'Mumbai Steel Trader', Amount: '100' },
  ];
  const { run } = runWith(rowsA, rowsB);
  const matchedB = run.index.bIndex[0];
  assert.equal(matchedB, 1, 'the closest text wins the contest');
  assert.equal(run.counts.ambiguous, 0);
});

test('large volumes stay fast and cached', () => {
  const names = ['ABC Traders Pvt Ltd', 'Mumbai Steel & Alloys', 'Delhi Cement Works', 'Sunrise Exports'];
  const rowsA = [];
  const rowsB = [];
  for (let i = 0; i < 20000; i++) {
    const n = names[i % names.length];
    rowsA.push({ 'Order ID': `OD${i}`, Customer: n, 'Order Amount': '100' });
    rowsB.push({ 'Voucher Ref': `OD${i}`, Party: i % 7 === 0 ? n.toUpperCase().replace(/\./g, '') : `${n} Co`, Amount: '100' });
  }
  const t0 = Date.now();
  const run = reconcile({ rowsA, rowsB, headersA: H_A, headersB: H_B, settings });
  const ms = Date.now() - t0;
  assert.equal(run.counts.matched + run.counts.mismatch, 20000);
  assert.ok(ms < 8000, `20k rows with text comparison took ${ms}ms`);
});
