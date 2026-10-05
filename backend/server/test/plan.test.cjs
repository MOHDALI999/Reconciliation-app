'use strict';
/**
 * Automatic plan tests. The point of every case is that the decision comes from
 * counted evidence in the data, not from a hardcoded preference.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAutoPlan, detectPrefix, conceptOf, chooseKey } = require('../core/plan.cjs');
const { profileColumns } = require('../core/engine.cjs');

/* --------------------------------------------------------------- fixtures */

function ordersRows(n = 40) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      'Order ID': `OD${1000 + i}`,
      'Order Date': `0${(i % 9) + 1}/03/2026`,
      Customer: `Party ${i} Traders`,
      'Order Amount': 1000 + i,
      Freight: 50 + (i % 7),
    });
  }
  return rows;
}

function tallyRows(n = 40, prefix = 'JV-CF-') {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      'Voucher Ref': `${prefix}${1000 + i}`,
      'Voucher Date': `0${(i % 9) + 1}/03/2026`,
      Party: `Party ${i} Traders`,
      Amount: 1000 + i,
      Freight: 50 + (i % 7),
    });
  }
  return rows;
}

const profile = (rows) => profileColumns(rows, Object.keys(rows[0]), {});

/* ------------------------------------------------------------ prefix detect */

test('detectPrefix finds a shared alphabetic prefix and keeps the digits', () => {
  assert.equal(detectPrefix(Array.from({ length: 20 }, (_, i) => `OD-${1000 + i}`)), 'OD-');
  assert.equal(detectPrefix(Array.from({ length: 20 }, (_, i) => `JV-CF-${9000 + i}`)), 'JV-CF-');
});

test('detectPrefix refuses digit-only prefixes and short samples', () => {
  assert.equal(detectPrefix(Array.from({ length: 20 }, (_, i) => `${1040 + i}`)), null);
  assert.equal(detectPrefix(['OD1', 'OD2']), null);
});

test('detectPrefix ignores a prefix that is not shared widely', () => {
  const mixed = Array.from({ length: 20 }, (_, i) => (i < 5 ? `OD${i}` : `${2000 + i}`));
  assert.equal(detectPrefix(mixed), null);
});

/* ------------------------------------------------------------ header naming */

test('conceptOf reads order-sheet and ledger wording as the same thing', () => {
  assert.equal(conceptOf('Order ID'), 'key');
  assert.equal(conceptOf('Voucher Ref'), 'key');
  assert.equal(conceptOf('Order Amount'), 'amount');
  assert.equal(conceptOf('Credit'), 'amount');
  assert.equal(conceptOf('Party'), 'party');
  assert.equal(conceptOf('Customer'), 'party');
  assert.equal(conceptOf('Particulars'), 'narration');
  assert.equal(conceptOf('Voucher Date'), 'date');
  assert.equal(conceptOf('Random Column'), null);
});

/* ---------------------------------------------------------------- key choice */

test('chooseKey strips different prefixes on each side so the keys meet', () => {
  const A = ordersRows();
  const B = tallyRows();
  const key = chooseKey(A, profile(A), B, profile(B));
  assert.equal(key.keyA, 'Order ID');
  assert.equal(key.keyB, 'Voucher Ref');
  assert.equal(key.keyRulesA.prefix, 'OD');
  assert.equal(key.keyRulesB.prefix, 'JV-CF-');
  assert.equal(key.matched, 40);
});

test('chooseKey leaves the values alone when they already meet', () => {
  const A = ordersRows();
  const B = tallyRows(40, 'OD');
  const key = chooseKey(A, profile(A), B, profile(B));
  assert.equal(key.keyRulesA.prefix, '');
  assert.equal(key.keyRulesB.prefix, '');
  assert.equal(key.matched, 40);
});

test('chooseKey prefers the column pair that actually overlaps, not the name', () => {
  // "Ref No" is named like a key but holds nothing in common; "Legacy Code" does.
  const A = ordersRows().map((r, i) => ({ ...r, 'Ref No': `X${i}`, 'Legacy Code': `LG${1000 + i}` }));
  const B = tallyRows(40, 'LG').map((r, i) => ({ ...r, 'Ref No': `Y${i}` }));
  const key = chooseKey(A, profile(A), B, profile(B));
  assert.equal(key.keyA, 'Legacy Code');
  assert.equal(key.keyB, 'Voucher Ref');
  assert.equal(key.matched, 40);
});

test('chooseKey reports a weak result instead of inventing a match', () => {
  // Same shape, but no identifier meets and the party column repeats, so there
  // is nothing to key on. The planner must admit that rather than force a pair.
  const A = ordersRows().map((r) => ({ ...r, Customer: 'Acme Traders' }));
  const B = tallyRows(40, 'ZZ9').map((r) => ({ ...r, Party: 'Acme Traders' }));
  const key = chooseKey(A, profile(A), B, profile(B));
  assert.equal(key.matched, 0);
  assert.equal(key.weak, true);
});

/* ------------------------------------------------------------- full plan */

test('buildAutoPlan pairs amount, date and party without being told', () => {
  const A = ordersRows();
  const B = tallyRows();
  const plan = buildAutoPlan({ rowsA: A, rowsB: B, profileA: profile(A), profileB: profile(B) });

  const byType = (t) => plan.pairs.filter((p) => p.type === t);
  assert.equal(byType('amount').length >= 1, true);
  assert.equal(byType('date').length, 1);

  const amount = plan.pairs.find((p) => p.colA === 'Order Amount');
  assert.equal(amount.colB, 'Amount');
  assert.equal(amount.type, 'amount');

  const date = plan.pairs.find((p) => p.colA === 'Order Date');
  assert.equal(date.colB, 'Voucher Date');

  const party = plan.pairs.find((p) => p.colA === 'Customer');
  assert.equal(party.colB, 'Party');
  assert.equal(party.type, 'auto');

  // Freight must not be paired with Amount when Freight exists on both sides.
  const freight = plan.pairs.find((p) => p.colA === 'Freight');
  assert.equal(freight.colB, 'Freight');
});

test('buildAutoPlan keeps user overrides and says so', () => {
  const A = ordersRows();
  const B = tallyRows();
  const plan = buildAutoPlan({
    rowsA: A, rowsB: B, profileA: profile(A), profileB: profile(B),
    overrides: { keyA: 'Customer', keyB: 'Party', pairs: [{ id: 'p1', colA: 'Order Amount', colB: 'Amount', type: 'amount' }] },
  });
  assert.equal(plan.keyA, 'Customer');
  assert.equal(plan.keyB, 'Party');
  assert.equal(plan.pairs.length, 1);
  assert.equal(plan.decisions.some((d) => /you picked these columns/.test(d.why)), true);
  assert.equal(plan.decisions.some((d) => /your saved settings/.test(d.why)), true);
});

test('buildAutoPlan explains every decision it made', () => {
  const A = ordersRows();
  const B = tallyRows();
  const plan = buildAutoPlan({ rowsA: A, rowsB: B, profileA: profile(A), profileB: profile(B) });
  assert.equal(plan.decisions.length >= 4, true);
  for (const d of plan.decisions) {
    assert.equal(typeof d.what, 'string');
    assert.equal(typeof d.chose, 'string');
    assert.equal(d.why.length > 5, true);
  }
  assert.equal(plan.evidence.matchedKeys, 40);
  assert.equal(plan.evidence.prefixB, 'JV-CF-');
});

test('buildAutoPlan is deterministic for the same input', () => {
  const A = ordersRows();
  const B = tallyRows();
  const one = buildAutoPlan({ rowsA: A, rowsB: B, profileA: profile(A), profileB: profile(B) });
  const two = buildAutoPlan({ rowsA: A, rowsB: B, profileA: profile(A), profileB: profile(B) });
  assert.deepEqual(one, two);
});
