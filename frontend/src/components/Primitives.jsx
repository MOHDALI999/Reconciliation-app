import { cx } from '../lib/ui.js';

/** Custom mark: two ledger columns, one tie-out line, one tick. */
export function Logo({ className = 'size-7' }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none" aria-label="Reconcile" role="img">
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <g stroke="#ffffff" strokeWidth="2.6" strokeLinecap="round" opacity="0.45">
        <path d="M9 8v16" />
        <path d="M23 8v16" />
      </g>
      <g stroke="#ffffff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 13h14" />
        <path d="M9 19.5l4 3.5 5-8" />
      </g>
    </svg>
  );
}

export function Button({ variant = 'default', size = 'md', className, ...props }) {
  const base = 'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium transition-[background-color,border-color,color,box-shadow] duration-150 disabled:opacity-45 disabled:cursor-not-allowed';
  const sizes = {
    sm: 'h-8 px-2.5 text-[12.5px]',
    md: 'h-9 px-3.5 text-[13px]',
    lg: 'h-10 px-5 text-[13.5px]',
  };
  const variants = {
    primary: 'bg-accent text-white shadow-[0_1px_2px_rgba(16,23,37,0.16)] hover:bg-accent-ink',
    default: 'border border-line-strong bg-surface text-ink hover:border-ink-soft/40 hover:bg-surface-2',
    ghost: 'text-ink-soft hover:bg-canvas hover:text-ink',
    quiet: 'text-white/70 hover:bg-white/10 hover:text-white',
    danger: 'border border-bad/25 bg-bad-soft text-bad hover:border-bad/45',
  };
  return <button type="button" className={cx(base, sizes[size], variants[variant], className)} {...props} />;
}

export function Card({ title, subtitle, action, children, className, bodyClassName }) {
  return (
    <section className={cx('overflow-hidden rounded-xl border border-line bg-surface', className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-line bg-surface-2 px-4 py-2.5">
          <div className="min-w-0">
            {title && <h2 className="truncate text-[13.5px] font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="truncate text-[12px] text-ink-soft">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      <div className={cx('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

export function Field({ label, hint, children, className }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1.5 block text-[12px] font-medium text-ink-mid">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-snug text-ink-soft">{hint}</span>}
    </label>
  );
}

const controlClass = 'h-9 w-full rounded-lg border border-line-strong bg-surface px-2.5 text-[13px] text-ink transition-colors hover:border-ink-soft/40 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15 disabled:bg-surface-2 disabled:text-ink-soft';

export function Select({ options, className, placeholder, ...props }) {
  return (
    <select className={cx(controlClass, 'appearance-none bg-[length:14px] bg-[right_0.5rem_center] bg-no-repeat pr-8', className)}
      style={{ backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23667281' stroke-width='1.6' stroke-linecap='round'><path d='M4 6.5l4 4 4-4'/></svg>\")" }}
      {...props}
    >
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((o) => {
        const value = typeof o === 'string' ? o : o.value;
        const label = typeof o === 'string' ? o : o.label;
        return <option key={value} value={value}>{label}</option>;
      })}
    </select>
  );
}

export const Input = ({ className, ...props }) => <input className={cx(controlClass, className)} {...props} />;

export function NumberInput({ value, onChange, min = 0, step = 'any', className, ...props }) {
  return (
    <input
      type="number"
      inputMode="decimal"
      min={min}
      step={step}
      value={value}
      onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
      className={cx(controlClass, 'num', className)}
      {...props}
    />
  );
}

export function Toggle({ checked, onChange, label, hint }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 rounded accent-[var(--color-accent)]"
      />
      <span className="min-w-0">
        <span className="block text-[13px] leading-snug text-ink">{label}</span>
        {hint && <span className="mt-0.5 block text-[11px] leading-snug text-ink-soft">{hint}</span>}
      </span>
    </label>
  );
}

/** Filter rail button. Count sits in a pill so the label never shifts. */
export function Chip({ active, count, children, ...props }) {
  return (
    <button
      type="button"
      aria-pressed={!!active}
      className={cx(
        'inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-[12.5px] font-medium transition-colors',
        active
          ? 'border-accent/35 bg-accent-soft text-accent-ink'
          : 'border-transparent text-ink-soft hover:bg-canvas hover:text-ink',
      )}
      {...props}
    >
      {children}
      {count !== undefined && (
        <span className={cx('num rounded px-1 py-px text-[11px]', active ? 'bg-white/70 text-accent-ink' : 'bg-canvas text-ink-soft')}>
          {Number.isFinite(count) ? count.toLocaleString('en-IN') : count}
        </span>
      )}
    </button>
  );
}

export function Badge({ tone = 'neutral', children, className }) {
  const tones = {
    neutral: 'bg-canvas text-ink-soft',
    accent: 'bg-accent-soft text-accent-ink',
    ok: 'bg-ok-soft text-ok',
    warn: 'bg-warn-soft text-warn',
    bad: 'bg-bad-soft text-bad',
  };
  return (
    <span className={cx('inline-flex h-5 items-center rounded px-1.5 text-[10.5px] font-semibold uppercase tracking-wide', tones[tone], className)}>
      {children}
    </span>
  );
}

export function Banner({ tone = 'info', title, children, action, icon }) {
  const tones = {
    info: 'border-line bg-surface text-ink',
    ok: 'border-ok/20 bg-ok-soft text-ok',
    warn: 'border-warn/25 bg-warn-soft text-warn',
    bad: 'border-bad/25 bg-bad-soft text-bad',
  };
  return (
    <div className={cx('flex items-start justify-between gap-3 rounded-xl border px-3.5 py-3 text-[13px]', tones[tone])}>
      <div className="flex min-w-0 items-start gap-2.5">
        {icon}
        <div className="min-w-0">
          {title && <p className="font-semibold">{title}</p>}
          {children && <div className="text-[12px] leading-relaxed opacity-95">{children}</div>}
        </div>
      </div>
      {action}
    </div>
  );
}

export function Disclosure({ label, children, defaultOpen = false }) {
  return (
    <details open={defaultOpen} className="group overflow-hidden rounded-xl border border-line bg-surface">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-2.5 text-[13px] font-medium text-ink-mid hover:bg-surface-2 hover:text-ink">
        <span>{label}</span>
        <svg viewBox="0 0 16 16" className="size-4 shrink-0 text-ink-soft transition-transform group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M4 6.5l4 4 4-4" />
        </svg>
      </summary>
      <div className="border-t border-line p-3.5">{children}</div>
    </details>
  );
}

export function Progress({ value, label, indeterminate }) {
  return (
    <div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
        <div
          className={cx('h-full rounded-full bg-accent', indeterminate ? 'w-1/3 animate-pulse' : 'transition-[width] duration-300')}
          style={indeterminate ? undefined : { width: `${Math.round((value || 0) * 100)}%` }}
        />
      </div>
      {label && <p className="mt-2 text-[12px] text-ink-soft">{label}</p>}
    </div>
  );
}

/** Horizontal similarity meter. Width is the score itself — never styled up or down. */
export function SimilarityBar({ value, line = 50, className }) {
  if (value === null || value === undefined) {
    return <span className={cx('num text-[12px] text-ink-soft', className)}>—</span>;
  }
  const pct = Math.max(0, Math.min(100, value));
  const tone = pct >= line ? 'bg-ok' : 'bg-bad';
  return (
    <span className={cx('flex items-center gap-2', className)} title={`${value.toFixed(2)}% similar · match line ${line}%`}>
      <span className="relative h-1.5 w-full min-w-6 max-w-[64px] overflow-hidden rounded-full bg-line">
        <span className={cx('absolute inset-y-0 left-0 rounded-full', tone)} style={{ width: `${pct}%` }} />
        <span className="absolute inset-y-0 w-px bg-ink/40" style={{ left: `${line}%` }} aria-hidden />
      </span>
      <span className="num w-9 shrink-0 text-right text-[12.5px] text-ink-mid">{Math.round(pct)}%</span>
    </span>
  );
}

/** The one verdict a non-technical user reads: a green Match or a red Not Match. */
export function MatchBadge({ ok, label, size = 'sm', className, warn = false }) {
  const tone = ok ? 'bg-ok-soft text-ok' : warn ? 'bg-warn-soft text-warn' : 'bg-bad-soft text-bad';
  const dot = ok ? 'bg-ok' : warn ? 'bg-warn' : 'bg-bad';
  return (
    <span
      className={cx(
        'inline-flex w-fit items-center gap-1 rounded-md font-semibold',
        size === 'lg' ? 'h-7 px-2.5 text-[12.5px]' : 'h-6 px-2 text-[11.5px]',
        tone,
        className,
      )}
    >
      <span aria-hidden className={cx('size-1.5 rounded-full', dot)} />
      {label || (ok ? 'Matched' : 'Mismatched')}
    </span>
  );
}
