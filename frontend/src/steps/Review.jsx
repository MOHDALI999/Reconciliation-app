import { useMemo, useState } from 'react';
import { Download, FileSpreadsheet, Search, ShieldCheck, ShieldAlert, X, Wand2, SlidersHorizontal } from 'lucide-react';
import ResultGrid from '../components/ResultGrid.jsx';
import Drawer from '../components/Drawer.jsx';
import { Badge, Banner, Button, Chip, Disclosure, Input, MatchBadge, SimilarityBar } from '../components/Primitives.jsx';
import { api } from '../lib/api.js';
import { cx, fmtInt, fmtMinor, normalizeThresholds, STATUS_TONE, TEXT_STATUS_LABEL, TABS } from '../lib/ui.js';

const isText = (cell) => cell.type === 'text' || cell.type === 'identifier';

/** The four results, one card each. Click a card to open that result. */
function KpiStrip({ summary, tab, onTab }) {
  const c = summary.counts;
  const cards = [
    { id: 'matched', label: 'Matched', value: c.matched, sub: 'same Order ID, every field matches', tone: 'text-ok', bar: 'bg-ok' },
    { id: 'breaks', label: 'Mismatched', value: c.mismatch + c.ambiguous, sub: 'same Order ID, a field differs', tone: 'text-bad', bar: 'bg-bad' },
    { id: 'onlyA', label: 'Only in File A', value: c.onlyA, sub: 'Order ID not in File B', tone: 'text-warn', bar: 'bg-warn' },
    { id: 'onlyB', label: 'Only in File B', value: c.onlyB, sub: 'Order ID not in File A', tone: 'text-warn', bar: 'bg-warn' },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((k) => (
        <button
          key={k.id}
          type="button"
          onClick={() => onTab(k.id)}
          className={cx('relative overflow-hidden rounded-xl border bg-surface px-4 py-3 text-left transition-colors', tab === k.id ? 'border-accent' : 'border-line hover:border-ink-soft')}
        >
          <span className={cx('absolute inset-y-0 left-0 w-[3px]', k.bar)} />
          <p className="eyebrow">{k.label}</p>
          <p className={cx('num mt-1 text-[26px] font-semibold leading-none tracking-tight', k.tone)}>{fmtInt(k.value)}</p>
          <p className="mt-1.5 text-[11.5px] text-ink-soft">{k.sub}</p>
        </button>
      ))}
    </div>
  );
}

function TieOut({ summary }) {
  const i = summary.integrity;
  const v = i.valueTotals;
  return (
    <Banner
      tone={i.ok ? 'ok' : 'bad'}
      icon={i.ok ? <ShieldCheck className="mt-px size-4 shrink-0" /> : <ShieldAlert className="mt-px size-4 shrink-0" />}
      title={i.ok ? 'Every row from both files is counted' : 'Row count check failed. Please check the files.'}
    >
      <div className="num mt-1 grid gap-x-8 gap-y-0.5 sm:grid-cols-2">
        <span>File A: {fmtInt(i.rowsA)} rows · accounted for {fmtInt(i.accountedA)}</span>
        <span>File B: {fmtInt(i.rowsB)} rows · accounted for {fmtInt(i.accountedB ?? i.rowsB)}</span>
        {v && <span>Value in A: {fmtMinor(v.totalA, summary.currency)} · matched {fmtMinor(v.matched, summary.currency)}</span>}
        {(i.keyCollisionsA > 0 || i.keyCollisionsB > 0) && (
          <span>Key collisions after clean-up: {fmtInt(i.keyCollisionsA)} in A, {fmtInt(i.keyCollisionsB)} in B</span>
        )}
      </div>
    </Banner>
  );
}

/** Only what a user needs: the two values, the similarity %, and the result. */
function TextBreakdown({ cell, line }) {
  const ok = cell.textStatus === 'MATCH';
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {[['File A value', cell.displayA], ['File B value', cell.displayB]].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-line bg-surface-2 px-3 py-2">
            <p className="eyebrow">{label}</p>
            <p className="mt-1 break-words text-[13px] text-ink">{value || ''}</p>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between rounded-lg border border-line px-3 py-2">
        <span className="text-[13px] text-ink-mid">
          Similarity: <span className="num font-semibold text-ink">{typeof cell.similarity === 'number' ? `${cell.similarity.toFixed(2)}%` : ''}</span>
        </span>
        <MatchBadge ok={ok} label={ok ? 'Matched' : 'Mismatched'} size="lg" />
      </div>
    </div>
  );
}

const DATE_FMT = { DMY: 'DD/MM/YYYY', MDY: 'MM/DD/YYYY', YMD: 'YYYY-MM-DD', SERIAL: 'Excel serial' };

/** A short, factual note under the field type: date format read, or tolerance. */
function cellHint(cell) {
  if (cell.type === 'date') {
    const a = DATE_FMT[cell.formatA] || cell.formatA;
    const b = DATE_FMT[cell.formatB] || cell.formatB;
    if (!a && !b) return '';
    const both = a && b && a === b ? a : [a, b].filter(Boolean).join(' vs ');
    return cell.formatAmbiguous ? `${both}, ambiguous` : both;
  }
  if (cell.type === 'amount' && cell.tolerance) return `tolerance ${cell.tolerance}`;
  return '';
}

/** Tab 1 of the drawer: the row as it is in the files, with one verdict per field. */
function RowResult({ row, line }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <MatchBadge ok={row.result === 'Matched'} warn={row.result === 'Only in File A' || row.result === 'Only in File B'} label={row.result} size="lg" />
        {row.group && <span className="text-[12px] text-ink-soft">Group {row.group.cardinality} · {row.group.sumA} vs {row.group.sumB}</span>}
      </div>

      {row.reason && <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-ink-mid">{row.reason}</p>}

      <div className="overflow-hidden rounded-xl border border-line">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-line bg-surface-2 text-left text-ink-soft">
              <th className="px-3 py-2 font-semibold">Field</th>
              <th className="px-3 py-2 font-semibold">File A</th>
              <th className="px-3 py-2 font-semibold">File B</th>
              <th className="px-3 py-2 text-right font-semibold">Result</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-line/70 align-top">
              <td className="px-3 py-2">
                <span className="block">Key</span>
                <span className="text-[10.5px] uppercase tracking-wide text-ink-soft">used to match</span>
              </td>
              <td className="num px-3 py-2">{row.keyA || ''}</td>
              <td className="num px-3 py-2">{row.keyB || ''}</td>
              <td className="mono px-3 py-2 text-right text-[11px] text-ink-soft">{row.keyNorm || ''}</td>
            </tr>
            {row.cells.map((cell) => (
              <tr key={cell.pairId} className="border-b border-line/70 last:border-0 align-top">
                <td className="px-3 py-2">
                  <span className="block">{cell.label}</span>
                  <span className="text-[10.5px] uppercase tracking-wide text-ink-soft">
                    {cell.type}{cellHint(cell) ? ` · ${cellHint(cell)}` : ''}
                  </span>
                </td>
                <td className="num max-w-[150px] break-words px-3 py-2">{cell.displayA || ''}</td>
                <td className="num max-w-[150px] break-words px-3 py-2">{cell.displayB || ''}</td>
                <td className="px-3 py-2 text-right">
                  {isText(cell) ? (
                    <span className="inline-flex flex-col items-end gap-1">
                      <MatchBadge ok={cell.textStatus === 'MATCH'} label={cell.textStatus === 'MATCH' ? 'Matched' : 'Mismatched'} />
                      {typeof cell.similarity === 'number' && (
                        <span className="num text-[11px] text-ink-soft">{cell.similarity.toFixed(2)}% similar</span>
                      )}
                    </span>
                  ) : (
                    <span className="inline-flex flex-col items-end gap-1">
                      <MatchBadge ok={!!cell.ok} label={cell.ok ? 'Matched' : 'Mismatched'} />
                      <span className="num text-[11px] text-ink-soft">{cell.diff || (cell.ok ? 'same' : 'not readable')}</span>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] leading-relaxed text-ink-soft">
        Values are shown as they are in your files. More info is in <span className="font-medium">Details</span>.
      </p>
    </div>
  );
}

/** Tab 2 of the drawer: everything behind the verdicts, out of the way of the data. */
function RowDetails({ row, line, currency }) {
  const textCells = row.cells.filter(isText);
  return (
    <div className="space-y-3">
      {textCells.length === 0 && <p className="text-[12.5px] text-ink-soft">No text fields were compared on this row.</p>}
      {textCells.map((cell) => (
        <Disclosure key={cell.pairId} label={cell.label} defaultOpen={textCells.length === 1}>
          <TextBreakdown cell={cell} line={line} />
        </Disclosure>
      ))}

      {row.cells.some((c) => !isText(c)) && (
        <Disclosure label="How amounts and dates were read">
          <table className="w-full text-[12px]">
            <tbody>
              {row.cells.filter((c) => !isText(c)).map((c) => (
                <tr key={c.pairId} className="border-b border-line/70 align-top last:border-0">
                  <td className="py-1.5 pr-2 text-ink-soft">{c.label}</td>
                  <td className="num py-1.5 pr-2">{c.parsedA || ''}</td>
                  <td className="num py-1.5 pr-2">{c.parsedB || ''}</td>
                  <td className={cx('num py-1.5 text-right', c.ok ? 'text-ok' : 'text-bad')}>{c.diff || (c.ok ? 'same' : 'not readable')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-soft">
            Amounts are compared in whole paise, so {currency}0.01 differences are real, not rounding noise. Dates are read with the format detected per column.
          </p>
        </Disclosure>
      )}

      <Disclosure label="All columns of this row">
        <div className="grid gap-3 sm:grid-cols-2">
          {[['shownA', 'File A'], ['shownB', 'File B']].map(([side, title]) => (row[side] || row[side === 'shownA' ? 'rowA' : 'rowB']) && (
            <div key={side}>
              <p className="eyebrow mb-1.5">{title}</p>
              <dl className="space-y-1">
                {Object.entries(row[side] || row[side === 'shownA' ? 'rowA' : 'rowB']).slice(0, 60).map(([k, v]) => (
                  <div key={k} className="flex gap-2 text-[12px]">
                    <dt className="w-1/2 shrink-0 truncate text-ink-soft">{k}</dt>
                    <dd className="num min-w-0 flex-1 truncate">{v === null || v === undefined ? '' : String(v)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </Disclosure>
    </div>
  );
}

function RowDrawerBody({ row, line, currency }) {
  const [tab, setTab] = useState('result');
  if (!row) return null;
  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-lg bg-surface-2 p-1" role="tablist">
        {[['result', 'Result'], ['details', 'Details']].map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cx(
              'flex-1 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors',
              tab === id ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(16,23,37,0.08)]' : 'text-ink-soft hover:text-ink',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'result' ? <RowResult row={row} line={line} /> : <RowDetails row={row} line={line} currency={currency} />}
    </div>
  );
}

/**
 * A one-line account of how this run was set up, with the counted evidence
 * behind each automatic choice available underneath.
 */
function DetectedStrip({ plan, ruleSource, onAdjust }) {
  if (!plan?.decisions?.length) return null;
  const e = plan.evidence || {};
  const stripped = [e.prefixA && `A: ${e.prefixA}`, e.prefixB && `B: ${e.prefixB}`].filter(Boolean).join(', ');
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
          <Wand2 className="size-3.5 text-accent" />
          {ruleSource === 'remembered' ? 'Your saved settings' : 'Matched using'}
        </span>
        <span className="num text-[12.5px] text-ink">{plan.keyA} and {plan.keyB}</span>
        {!e.weak && e.matchedKeys > 0 && (
          <span className="num text-[12px] text-ink-soft">
            {fmtInt(e.matchedKeys)} of {fmtInt(Math.min(e.sampledKeysA || 0, e.sampledKeysB || 0))} checked IDs are in both files
          </span>
        )}
        {stripped && <span className="text-[12px] text-ink-soft">ignoring the start text {stripped}</span>}
        {e.weak && <Badge tone="warn">please check the Order ID columns</Badge>}
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onAdjust}>
          <SlidersHorizontal className="size-3.5" /> Change settings
        </Button>
      </div>
      <div className="mt-2">
        <Disclosure label={`How the app set this up`}>
          <ul className="space-y-1.5">
            {plan.decisions.map((d, i) => (
              <li key={`${d.what}-${i}`} className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
                <span className="font-medium text-ink">{d.what}:</span>
                <span className="num text-ink">{d.chose}</span>
                <span className="text-ink-soft">({d.why})</span>
              </li>
            ))}
          </ul>
        </Disclosure>
      </div>
    </div>
  );
}

export default function Review({ runId, summary, stats, onRestart, ruleSource, onAdjust }) {
  const [tab, setTab] = useState('allData');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [openRow, setOpenRow] = useState(null);

  const counts = summary.counts;
  const tabCounts = useMemo(() => ({
    allData: counts.matched + counts.mismatch + counts.ambiguous + counts.onlyA + counts.onlyB,
    breaks: counts.mismatch + counts.ambiguous,
    onlyA: counts.onlyA,
    onlyB: counts.onlyB,
    matched: counts.matched,
  }), [counts]);

  const line = normalizeThresholds(summary.settings?.textThresholds).match;
  const hasText = (summary.pairs || []).some((p) => p.type === 'text' || p.type === 'identifier');
  const scopeLabel = TABS.find((t) => t.id === tab)?.label || tab;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Step 3 of 3</p>
          <h2 className="mt-1 text-[19px] font-semibold tracking-tight">Results</h2>
          <p className="mt-1 text-[13px] text-ink-soft">
            {hasText
              ? <>Rows are matched by Order ID. Text <span className="num font-medium text-ink">{line}% or more</span> similar is <span className="font-medium text-ok">Matched</span>, below is <span className="font-medium text-bad">Mismatched</span>. Dates must be the same day (A - B = 0). Values are shown as they are in your files.</>
              : 'Values are shown as they are in your files.'}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button variant="primary" size="lg" onClick={() => window.open(api.exportXlsxUrl(runId, 'all'), '_blank')}>
            <FileSpreadsheet className="size-4" /> Download Excel (all results)
          </Button>
          <p className="text-[11px] text-ink-soft">5 sheets: All Data, Matched, Mismatched, Only in File A, Only in File B</p>
        </div>
      </div>

      <KpiStrip summary={summary} tab={tab} onTab={setTab} />
      <DetectedStrip plan={summary.plan} ruleSource={ruleSource} onAdjust={onAdjust} />

      <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-1.5 lg:flex-row lg:items-center">
        <div className="rail-scroll -mb-px flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {TABS.map((t) => (
            <Chip key={t.id} active={tab === t.id} count={tabCounts[t.id]} onClick={() => setTab(t.id)}>{t.label}</Chip>
          ))}
        </div>
        <div className="flex items-center gap-2 lg:pl-2">
          <div className="relative flex-1 lg:flex-none">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-soft" />
            <Input
              value={searchInput}
              placeholder="Search any value"
              className="w-full pl-8 pr-7 lg:w-56"
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setSearch(searchInput.trim()); }}
              onBlur={() => setSearch(searchInput.trim())}
            />
            {searchInput && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => { setSearchInput(''); setSearch(''); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-soft hover:text-ink"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={() => window.open(api.exportXlsxUrl(runId, tab), '_blank')} title={`Excel file of ${scopeLabel}`}>
            <FileSpreadsheet className="size-3.5" /> Excel
          </Button>
          <Button variant="ghost" size="sm" onClick={() => window.open(api.exportUrl(runId, tab, false), '_blank')} title={`CSV file of ${scopeLabel}`}>
            <Download className="size-3.5" /> CSV
          </Button>
          <Button variant="ghost" size="sm" onClick={onRestart}>New comparison</Button>
        </div>
      </div>

      <ResultGrid runId={runId} tab={tab} search={search} pairs={summary.pairs} headersA={summary.headersA} headersB={summary.headersB} keyA={summary.keyA} keyB={summary.keyB} onOpenRow={setOpenRow} />


      <Drawer
        open={!!openRow}
        title={openRow ? `${openRow.keyA || openRow.keyB}` : ''}
        subtitle={openRow ? openRow.result : ''}
        onClose={() => setOpenRow(null)}
      >
        <RowDrawerBody key={openRow?.id} row={openRow} line={line} currency={summary.currency} />
      </Drawer>
    </div>
  );
}
