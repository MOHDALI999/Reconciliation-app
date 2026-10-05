import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { api } from '../lib/api.js';
import { cx, fmtInt, STATUS_TONE } from '../lib/ui.js';
import { MatchBadge } from './Primitives.jsx';

const PAGE = 100;
const ROW_H = 54;          // fixed two-line rows, so the virtualiser can never drift
const CACHE_PAGES = 12;

/**
 * Windowed row loader. One in-flight request per window, aborted when the
 * window changes, and a bounded page cache so long scrolling cannot grow
 * without limit.
 */
function useRowWindow({ runId, tab, search }) {
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(() => new Map());
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const controllers = useRef(new Map());
  const wanted = useRef(new Set());

  // Reset when the query changes.
  useEffect(() => {
    for (const c of controllers.current.values()) c.abort();
    controllers.current.clear();
    wanted.current.clear();
    setPages(new Map());
    setTotal(0);
    setError(null);
    setLoading(true);
  }, [runId, tab, search]);

  const ensurePages = useCallback((indexes) => {
    for (const pageIndex of indexes) {
      if (pageIndex < 0 || wanted.current.has(pageIndex)) continue;
      wanted.current.add(pageIndex);
      const controller = new AbortController();
      controllers.current.set(pageIndex, controller);
      api.getRows({ runId, tab, search, offset: pageIndex * PAGE, limit: PAGE }, controller.signal)
        .then((res) => {
          setTotal(res.total);
          setPages((prev) => {
            const next = new Map(prev);
            next.set(pageIndex, res.rows);
            if (next.size > CACHE_PAGES) {
              const oldest = [...next.keys()].sort((a, b) => Math.abs(a - pageIndex) - Math.abs(b - pageIndex)).pop();
              next.delete(oldest);
              wanted.current.delete(oldest);
            }
            return next;
          });
          setError(null);
        })
        .catch((err) => {
          wanted.current.delete(pageIndex);
          if (err.name !== 'AbortError') setError(err.message);
        })
        .finally(() => {
          controllers.current.delete(pageIndex);
          setLoading(false);
        });
    }
  }, [runId, tab, search]);

  useEffect(() => { ensurePages([0]); }, [ensurePages]);

  const rowAt = useCallback((i) => pages.get(Math.floor(i / PAGE))?.[i % PAGE] ?? null, [pages]);

  return { total, rowAt, ensurePages, error, loading };
}

/** A value exactly as the file showed it. Nothing is reformatted and no placeholder symbol is added. */
function RawCell({ value, muted }) {
  const text = value === null || value === undefined ? '' : String(value);
  return (
    <span className={cx('num block cell-clip text-[13px]', muted && 'text-ink-mid')} title={text}>
      {text}
    </span>
  );
}

const isTextType = (t) => t === 'text' || t === 'identifier';
const fmt2 = (n) => (Number.isFinite(n) ? n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');

/**
 * Columns follow the result being viewed:
 *  - Matched / Mismatched: Order ID (A), Order ID (B), then per compared field
 *    A value, B value and Similarity % (text) or Diff A - B (date, amount), then Result.
 *  - Only in File A / Only in File B: that file's own columns, exactly as in the file.
 */
function useColumnPlan(pairs, tab, headersA, headersB, keyA, keyB) {
  return useMemo(() => {
    const W = 150;
    if (tab === 'onlyA' || tab === 'onlyB') {
      const headers = (tab === 'onlyA' ? headersA : headersB) || [];
      const cols = headers.map((h) => ({ id: `src:${h}`, label: h, src: tab === 'onlyA' ? 'shownA' : 'shownB', col: h, w: W }));
      return { cols, template: cols.map((c) => `${c.w}px`).join(' ') || '1fr', min: cols.reduce((t, c) => t + c.w + 12, 40) };
    }
    const cols = [
      { id: 'keyA', label: `${keyA} (File A)`, w: 140 },
      { id: 'keyB', label: `${keyB} (File B)`, w: 140 },
    ];
    for (const p of (pairs || []).filter((x) => !(x.colA === keyA && x.colB === keyB))) {
      cols.push({ id: `a:${p.id}`, label: `${p.colA} (File A)`, pairId: p.id, side: 'A', w: W });
      cols.push({ id: `b:${p.id}`, label: `${p.colB} (File B)`, pairId: p.id, side: 'B', w: W });
      if (isTextType(p.type)) cols.push({ id: `s:${p.id}`, label: 'Similarity %', pairId: p.id, calc: 'similarity', w: 110, align: 'text-right' });
      else if (p.type === 'date') cols.push({ id: `d:${p.id}`, label: 'Diff (A - B) days', pairId: p.id, calc: 'days', w: 120, align: 'text-right' });
      else if (p.type === 'amount') cols.push({ id: `m:${p.id}`, label: 'Diff (A - B)', pairId: p.id, calc: 'amount', w: 120, align: 'text-right' });
    }
    cols.push({ id: 'result', label: 'Result', w: 130 });
    return { cols, template: cols.map((c) => `${c.w}px`).join(' '), min: cols.reduce((t, c) => t + c.w + 12, 40) };
  }, [pairs, tab, headersA, headersB, keyA, keyB]);
}

const oneSided = (row) => row.result === 'Only in File A' || row.result === 'Only in File B';

function renderCell(c, row) {
  if (c.src) return <RawCell key={c.id} value={row[c.src]?.[c.col]} />;
  if (c.id === 'keyA') return <RawCell key={c.id} value={row.keyA} />;
  if (c.id === 'keyB') return <RawCell key={c.id} value={row.keyB} muted />;
  if (c.id === 'result') return <span key={c.id}><MatchBadge ok={row.result === 'Matched'} warn={oneSided(row)} label={row.result} /></span>;
  const cell = row.cells?.find((x) => x.pairId === c.pairId);
  if (c.side === 'A') return <RawCell key={c.id} value={cell?.displayA} />;
  if (c.side === 'B') return <RawCell key={c.id} value={cell?.displayB} muted />;
  let text = '';
  let bad = false;
  if (oneSided(row)) return <span key={c.id} />;
  if (c.calc === 'similarity' && typeof cell?.similarity === 'number') { text = cell.similarity.toFixed(2); bad = cell.textStatus !== 'MATCH'; }
  if (c.calc === 'days' && typeof cell?.diffDays === 'number') { text = String(cell.diffDays); bad = cell.diffDays !== 0; }
  if (c.calc === 'amount' && typeof cell?.diffMinor === 'number') { text = fmt2(cell.diffMinor / 100); bad = !cell.ok; }
  return <span key={c.id} className={cx('num cell-clip text-right font-medium', bad ? 'text-bad' : 'text-ok')}>{text}</span>;
}

export default function ResultGrid({ runId, tab, search, pairs, headersA, headersB, keyA, keyB, onOpenRow }) {
  const { cols, template, min } = useColumnPlan(pairs, tab, headersA, headersB, keyA, keyB);
  const { total, rowAt, ensurePages, error, loading } = useRowWindow({ runId, tab, search });
  const scroller = useRef(null);
  const [cursor, setCursor] = useState(0);

  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  const items = virtualizer.getVirtualItems();

  useEffect(() => {
    if (!items.length) return;
    const first = Math.floor(items[0].index / PAGE);
    const last = Math.floor(items[items.length - 1].index / PAGE);
    ensurePages([first, last, first - 1, last + 1].filter((p) => p >= 0 && p * PAGE < Math.max(total, 1)));
  }, [items, ensurePages, total]);

  useEffect(() => { setCursor(0); }, [tab, search]);

  const onKeyDown = (e) => {
    if (!total) return;
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(total - 1, c + 1)); virtualizer.scrollToIndex(Math.min(total - 1, cursor + 1)); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); virtualizer.scrollToIndex(Math.max(0, cursor - 1)); }
    else if (e.key === 'Enter') { const row = rowAt(cursor); if (row) onOpenRow(row); }
  };

  return (
    <div className="flex min-h-[440px] flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface lg:min-h-0">
      <div
        ref={scroller}
        role="grid"
        aria-rowcount={total}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-auto outline-none"
      >
        <div style={{ minWidth: Math.max(min, 600) }}>
          <div
            className="sticky top-0 z-10 grid items-center gap-3 border-b border-line bg-surface-2/95 px-3.5 py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-soft backdrop-blur"
            style={{ gridTemplateColumns: template }}
          >
            {cols.map((c) => <span key={c.id} className={cx('cell-clip', c.align)} title={c.label}>{c.label}</span>)}
          </div>

          {error && <p className="px-3.5 py-4 text-[13px] text-bad">{error}</p>}
          {!error && total === 0 && (
            <div className="px-4 py-16 text-center">
              {loading ? (
                <p className="text-[13px] text-ink-soft">Loading rows…</p>
              ) : (
                <>
                  <p className="text-[13.5px] font-medium text-ink">No rows here</p>
                  <p className="mt-1 text-[12.5px] text-ink-soft">
                    {search ? 'No row matches your search. Clear the search to see all rows.' : 'No rows here. Try another tab.'}
                  </p>
                </>
              )}
            </div>
          )}

          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {items.map((item) => {
              const row = rowAt(item.index);
              const selected = item.index === cursor;
              return (
                <div
                  key={item.key}
                  role="row"
                  aria-rowindex={item.index + 1}
                  onClick={() => { setCursor(item.index); if (row) onOpenRow(row); }}
                  className={cx(
                    'absolute inset-x-0 grid cursor-pointer items-center gap-3 border-b border-line/70 px-3.5 text-[13px]',
                    selected ? 'bg-accent-soft' : 'hover:bg-surface-2',
                  )}
                  style={{ height: ROW_H, transform: `translateY(${item.start}px)`, gridTemplateColumns: template }}
                >
                  {row ? cols.map((c) => renderCell(c, row)) : (
                    <span className="h-3 animate-pulse rounded bg-line" style={{ gridColumn: `span ${cols.length}` }} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <footer className="flex items-center justify-between gap-3 border-t border-line bg-surface-2 px-3.5 py-2 text-[11.5px] text-ink-soft">
        <span className="num">{fmtInt(total)} rows</span>
        <span className="hidden sm:inline">Values are shown as they are in your files. Click a row for details.</span>
      </footer>
    </div>
  );
}
