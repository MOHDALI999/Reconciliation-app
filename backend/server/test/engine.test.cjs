'use strict';
/**
 * Golden tests. Every case here is a defect that the previous engine shipped;
 * they exist so the numbers can never silently regress again.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const V = require('../core/values.cjs');
const { reconcile, getPage } = require('../core/engine.cjs');

const run = (rowsA, rowsB, settings) => reconcile({
  rowsA,
  rowsB,
  headersA: Object.keys(rowsA[0] || { id: '' }),
  headersB: Object.keys(rowsB[0] || { id: '' }),
  settings: { keyA: 'id', keyB: 'id', ...settings },
});

/* ------------------------------------------------------------------ money */

test('money is compared in integer minor units', () => {
  assert.equal(V.parseMoneyMinor('1,500.50'), 150050);
  assert.equal(V.parseMoneyMinor('₹1,500.50'), 150050);
  assert.equal(V.parseMoneyMinor('(1,500)'), -150000);
  assert.equal(V.parseMoneyMinor('1.500,00'), 150000);
  assert.equal(V.parseMoneyMinor('1500.00 Cr'), -150000);
  assert.equal(V.parseMoneyMinor('1500.00 Dr'), 150000);
  assert.equal(V.parseMoneyMinor('1500-'), -150000);
  assert.equal(V.parseMoneyMinor('abc'), null);
});

test('0.1 + 0.2 equals 0.3 at zero tolerance', () => {
  assert.equal(V.compareMoney(0.1 + 0.2, 0.3).ok, true);
});

test('"1500.50" matches 1500.5 regardless of column name', () => {
  const r = run(
    [{ id: 'A1', freight: '1500.50' }],
    [{ id: 'A1', freight: 1500.5 }],
    { pairs: [{ id: 'p1', colA: 'freight', colB: 'freight' }] },
  );
  assert.equal(r.counts.matched, 1);
  assert.equal(r.pairs[0].type, 'amount');
});

test('Tally Cr values match a negative order amount', () => {
  const r = run(
    [{ id: 'A1', amt: -1500 }],
    [{ id: 'A1', amt: '1,500.00 Cr' }],
    { pairs: [{ id: 'p1', colA: 'amt', colB: 'amt' }] },
  );
  assert.equal(r.counts.matched, 1);
});

test('percentage tolerance works alongside absolute tolerance', () => {
  const r = run(
    [{ id: 'A1', amt: 1000 }],
    [{ id: 'A1', amt: 1005 }],
    { pairs: [{ id: 'p1', colA: 'amt', colB: 'amt', pctTol: 1 }] },
  );
  assert.equal(r.counts.matched, 1);
});

/* ------------------------------------------------------------ cardinality */

test('a file B row is never consumed twice', () => {
  const r = run(
    [{ id: '1', amt: 10 }, { id: '1', amt: 10 }],
    [{ id: '1', amt: 10 }],
    { pairs: [{ id: 'p1', colA: 'amt', colB: 'amt' }], groupMatching: false },
  );
  assert.equal(r.counts.matched, 1);
  assert.equal(r.counts.onlyA, 1);
});

test('1:N split settlement is matched as one group when sums tie', () => {
  const r = run(
    [{ id: '1', amt: 100 }],
    [{ id: '1', amt: 60 }, { id: '1', amt: 40 }],
    { pairs: [{ id: 'p1', colA: 'amt', colB: 'amt' }], groupMatching: true },
  );
  assert.equal(r.counts.matched, 1);
  assert.equal(r.counts.groups, 1);
  assert.equal(r.counts.onlyB, 0);
  assert.equal(r.groups[0].cardinality, '1:2');
});

test('1:N with sums that do not tie is not silently matched', () => {
  const r = run(
    [{ id: '1', amt: 100 }],
    [{ id: '1', amt: 60 }, { id: '1', amt: 30 }],
    { pairs: [{ id: 'p1', colA: 'amt', colB: 'amt' }] },
  );
  assert.equal(r.counts.groups, 0);
  assert.equal(r.counts.matched + r.counts.mismatch, 1);
});

test('the best candidate wins, not the first one', () => {
  const r = run(
    [{ id: '1', amt: 20 }],
    [{ id: '1', amt: 10 }, { id: '1', amt: 20 }],
    { pairs: [{ id: 'p1', colA: 'amt', colB: 'amt' }], groupMatching: false },
  );
  const page = getPage(r, [{ id: '1', amt: 20 }], [{ id: '1', amt: 10 }, { id: '1', amt: 20 }], { tab: 'matched' });
  assert.equal(r.counts.matched, 1);
  // The grid shows the value exactly as the file had it; the parsed form is kept alongside.
  assert.equal(page.rows[0].cells[0].displayB, '20');
  assert.equal(page.rows[0].cells[0].parsedB, '₹20.00');
});

test('a duplicate Order ID with an equally good partner is judged on its fields', () => {
  const r = run(
    [{ id: '1', amt: 20 }],
    [{ id: '1', amt: 20 }, { id: '1', amt: 20 }],
    { pairs: [{ id: 'p1', colA: 'amt', colB: 'amt' }], groupMatching: false },
  );
  assert.equal(r.counts.ambiguous, 0);
  assert.equal(r.counts.matched, 1);
  assert.equal(r.counts.onlyB, 1, 'the unused duplicate is only in file B');
});

test('date difference is File A minus File B; only 0 is Matched', () => {
  const one = (a, b) => {
    const rowsA = [{ id: '1', d: a }];
    const rowsB = [{ id: '1', d: b }];
    const r = run(rowsA, rowsB,
      { pairs: [{ id: 'p1', colA: 'd', colB: 'd', type: 'date', dateFormatA: 'DMY', dateFormatB: 'DMY' }] });
    const row = getPage(r, rowsA, rowsB, { tab: 'all' }).rows[0];
    return { r, cell: row.cells[0], row };
  };
  const same = one('15/09/2026', '15/09/2026');
  assert.equal(same.r.counts.matched, 1);
  assert.equal(same.cell.diffDays, 0);
  const off = one('15/09/2026', '16/09/2026');
  assert.equal(off.r.counts.mismatch, 1);
  assert.equal(off.cell.diffDays, -1);
  assert.equal(off.row.result, 'Mismatched');
  assert.equal(one('16/09/2026', '15/09/2026').cell.diffDays, 1);
});

test('N:M duplicates pair up without reuse', () => {
  const r = run(
    [{ id: '1', amt: 10 }, { id: '1', amt: 20 }],
    [{ id: '1', amt: 20 }, { id: '1', amt: 10 }],
    { pairs: [{ id: 'p1', colA: 'amt', colB: 'amt' }], groupMatching: false },
  );
  assert.equal(r.counts.matched, 2);
  assert.equal(r.counts.onlyB, 0);
});

test('result is stable when the input order is reversed', () => {
  const rowsA = [{ id: '2', amt: 5 }, { id: '1', amt: 10 }];
  const rowsB = [{ id: '1', amt: 10 }, { id: '2', amt: 5 }];
  const a = run(rowsA, rowsB, { pairs: [{ id: 'p1', colA: 'amt', colB: 'amt' }] });
  const b = run([...rowsA].reverse(), [...rowsB].reverse(), { pairs: [{ id: 'p1', colA: 'amt', colB: 'amt' }] });
  assert.deepEqual(a.counts, b.counts);
});

/* ------------------------------------------------------------ completeness */

test('no source row is ever dropped and the run ties out', () => {
  const rowsA = [{ id: 'A1', amt: 10 }, { id: '', amt: 20 }, { id: 'Total', amt: 30 }];
  const r = run(rowsA, [{ id: 'A1', amt: 10 }], { pairs: [{ id: 'p1', colA: 'amt', colB: 'amt' }] });
  assert.equal(r.integrity.rowsA, 3);
  assert.equal(r.integrity.accountedA, 3);
  assert.equal(r.integrity.rowTieOutA, true);
  assert.equal(r.integrity.excludedA.blankKey, 1);
  assert.equal(r.integrity.excludedA.summaryRow, 1);
  assert.equal(r.integrity.valueTieOut, true);
  assert.equal(r.integrity.ok, true);
});

test('a legitimate key beginning with "Total" is not treated as a summary row', () => {
  const r = run([{ id: 'Total Parts Ltd', amt: 10 }], [{ id: 'Total Parts Ltd', amt: 10 }], {
    pairs: [{ id: 'p1', colA: 'amt', colB: 'amt' }],
  });
  assert.equal(r.counts.matched, 1);
  assert.equal(r.integrity.excludedA.summaryRow, 0);
});

test('key collisions are counted instead of silently matched', () => {
  const r = run(
    [{ id: '1001.50', amt: 1 }, { id: '100150', amt: 1 }],
    [{ id: '100150', amt: 1 }],
    { pairs: [{ id: 'p1', colA: 'amt', colB: 'amt' }], groupMatching: false },
  );
  assert.equal(r.integrity.keyCollisionsA, 1);
});

/* -------------------------------------------------------------------- dates */

test('a four-digit year is not read as an Excel serial', () => {
  assert.equal(V.parseDate('2026', { format: 'DMY' }).status, 'INVALID');
  assert.equal(V.excelSerialToISO(45000), '2023-03-15');
});

test('the 1904 workbook epoch is honoured', () => {
  assert.equal(V.excelSerialToISO(45000, { date1904: false }), '2023-03-15');
  assert.equal(V.excelSerialToISO(45000, { date1904: true }), '2027-03-16');
});

test('two-digit years use a 1970 pivot', () => {
  assert.equal(V.toISO(99, 1, 1), '1999-01-01');
  assert.equal(V.toISO(26, 1, 1), '2026-01-01');
});

test('an ambiguous date column is flagged instead of failing every row', () => {
  const r = run(
    [{ id: '1', d: '03/04/2026' }],
    [{ id: '1', d: '03/04/2026' }],
    { pairs: [{ id: 'p1', colA: 'd', colB: 'd' }] },
  );
  assert.equal(r.pairs[0].dateAmbiguousA, true);
  assert.ok(r.pairs[0].dateReasonA.length > 0);
});

test('an explicit date format resolves the ambiguity', () => {
  const r = run(
    [{ id: '1', d: '03/04/2026' }],
    [{ id: '1', d: '04/03/2026' }],
    { pairs: [{ id: 'p1', colA: 'd', colB: 'd', type: 'date', dateFormatA: 'DMY', dateFormatB: 'MDY' }] },
  );
  assert.equal(r.counts.matched, 1);
});

test('date windows are asymmetric', () => {
  const settle = (before, after) => run(
    [{ id: '1', d: '10/03/2026' }],
    [{ id: '1', d: '12/03/2026' }],
    { pairs: [{ id: 'p1', colA: 'd', colB: 'd', type: 'date', dateFormatA: 'DMY', dateFormatB: 'DMY', dateBefore: before, dateAfter: after }] },
  ).counts;
  assert.equal(settle(0, 3).matched, 1);
  assert.equal(settle(3, 0).matched, 0);
});

test('a non-date text pair stays text even when another pair is a date', () => {
  const r = run(
    [{ id: '1', d: '10/03/2026', party: 'Acme' }],
    [{ id: '1', d: '10/03/2026', party: 'Acme' }],
    {
      pairs: [
        { id: 'p1', colA: 'd', colB: 'd', type: 'date', dateFormatA: 'DMY', dateFormatB: 'DMY' },
        { id: 'p2', colA: 'party', colB: 'party' },
      ],
    },
  );
  assert.equal(r.pairs[1].type, 'text');
  assert.equal(r.counts.matched, 1);
});

/* ----------------------------------------------------------------- fallback */

test('date + amount fallback rescues rows with no usable id match', () => {
  const rowsA = [{ id: 'X1', d: '10/03/2026', amt: 500 }];
  const rowsB = [{ id: 'ZZ9', d: '10/03/2026', amt: 500 }];
  const settings = {
    pairs: [
      { id: 'p1', colA: 'amt', colB: 'amt', type: 'amount' },
      { id: 'p2', colA: 'd', colB: 'd', type: 'date', dateFormatA: 'DMY', dateFormatB: 'DMY' },
    ],
    dateAmountFallback: true,
  };
  assert.equal(run(rowsA, rowsB, settings).counts.matched, 1);
  assert.equal(run(rowsA, rowsB, { ...settings, dateAmountFallback: false }).counts.matched, 0);
});

/* ------------------------------------------------------------------ filters */

test('filters exclude rows explicitly instead of deleting them', () => {
  const rowsA = [{ id: '1', amt: 10, region: 'MH' }, { id: '2', amt: 20, region: 'KA' }];
  const r = run(rowsA, [{ id: '1', amt: 10, region: 'MH' }], {
    pairs: [{ id: 'p1', colA: 'amt', colB: 'amt' }],
    filtersA: [{ column: 'region', include: ['MH'] }],
  });
  assert.equal(r.counts.matched, 1);
  assert.equal(r.integrity.excludedA.filteredOut, 1);
  assert.equal(r.integrity.rowTieOutA, true);
});

/* -------------------------------------------------------------------- paging */

test('paging and search return the same rows the counts promise', () => {
  const rowsA = Array.from({ length: 250 }, (_, i) => ({ id: `A${i}`, amt: i }));
  const rowsB = rowsA.map((r) => ({ id: r.id, amt: r.amt % 7 === 0 ? r.amt + 1 : r.amt }));
  const r = run(rowsA, rowsB, { pairs: [{ id: 'p1', colA: 'amt', colB: 'amt' }] });
  const breaks = getPage(r, rowsA, rowsB, { tab: 'breaks', offset: 0, limit: 1000 });
  assert.equal(breaks.total, r.counts.mismatch);
  assert.equal(breaks.rows.length, r.counts.mismatch);
  const searched = getPage(r, rowsA, rowsB, { tab: 'all', search: 'A101', limit: 50 });
  assert.equal(searched.rows[0].keyA, 'A101');
  const page2 = getPage(r, rowsA, rowsB, { tab: 'all', offset: 100, limit: 10 });
  assert.equal(page2.rows[0].keyA, 'A100');
});

test('an invalid extract pattern fails loudly', () => {
  assert.throws(() => V.normalizeKey('X', { extract: '([' }));
});

test('key normalisation steps are reported', () => {
  const { key, steps } = V.normalizeKey('#INV-001', { stripSeparators: true, caseFold: true });
  assert.equal(key, 'inv001');
  assert.ok(steps.includes('strip-separators'));
});
