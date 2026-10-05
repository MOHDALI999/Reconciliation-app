import { useMemo } from 'react';
import { ArrowRight, CalendarDays, Hash, Plus, Trash2, Wand2, Play, Sparkles } from 'lucide-react';
import { Badge, Banner, Button, Card, Disclosure, Field, NumberInput, Input, Select, Toggle } from '../components/Primitives.jsx';
import { cx, normalizeThresholds } from '../lib/ui.js';

const TYPE_OPTIONS = [
  { value: 'auto', label: 'Auto (from data)' },
  { value: 'amount', label: 'Amount' },
  { value: 'date', label: 'Date' },
  { value: 'identifier', label: 'Identifier' },
  { value: 'text', label: 'Text' },
];
const DATE_FORMATS = [
  { value: 'auto', label: 'Auto' },
  { value: 'DMY', label: 'DD/MM/YYYY' },
  { value: 'MDY', label: 'MM/DD/YYYY' },
  { value: 'YMD', label: 'YYYY-MM-DD' },
  { value: 'SERIAL', label: 'Excel serial' },
];
const TYPE_TONE = { amount: 'accent', date: 'accent', identifier: 'neutral', text: 'neutral' };

const profileOf = (file, column) => file?.profile?.find((p) => p.name === column) || null;

const DATE_FORMAT_LABEL = { DMY: 'DD/MM/YYYY', MDY: 'MM/DD/YYYY', YMD: 'YYYY-MM-DD', SERIAL: 'Excel serial' };

/** Read a money-ish sample the same way the engine does: last resort is null. */
function sampleAmount(value) {
  const raw = String(value ?? '').replace(/[^0-9.,\-]/g, '').replace(/,/g, '');
  const n = Number(raw);
  return Number.isFinite(n) && raw !== '' ? n : null;
}

const money = (n) => `₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What the engine will treat as a break for this amount rule, in words. */
function toleranceSentence(pair) {
  const abs = Number(pair.absTol) || 0;
  const pct = Number(pair.pctTol) || 0;
  if (!abs && !pct) return 'Any difference is a mismatch. The two amounts must be exactly the same.';
  const parts = [];
  if (abs) parts.push(`${money(abs)}`);
  if (pct) parts.push(`${pct}% of the larger side`);
  return `It is a mismatch when the difference is more than ${parts.join(' or ')}.`;
}

/** Mirrors the server's resolveAutoType: a disagreement falls back to identifier or text. */
function resolveEffectiveType(pair, pA, pB) {
  if (pair.type !== 'auto') return pair.type;
  if (!pA?.type && !pB?.type) return 'text';
  if (pA?.type === pB?.type) return pA.type;
  if (pA?.type === 'identifier' || pB?.type === 'identifier') return 'identifier';
  return 'text';
}

/**
 * Shows what "difference" will mean for this rule: the sample values read as
 * money, their gap, and whether that gap would be a break. Sample rows are not
 * row-aligned across files, so the gap is labelled as an illustration.
 */
function AmountPreview({ pair, pA, pB }) {
  const a = sampleAmount(pA?.samples?.[0]);
  const b = sampleAmount(pB?.samples?.[0]);
  const gap = a !== null && b !== null ? a - b : null;
  const tol = Math.max(Number(pair.absTol) || 0, (Math.max(Math.abs(a || 0), Math.abs(b || 0)) * (Number(pair.pctTol) || 0)) / 100);
  const breaks = gap !== null && Math.abs(gap) > tol + 1e-9;

  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
      <p className="eyebrow flex items-center gap-1.5"><Hash className="size-3" /> Difference</p>
      {gap === null ? (
        <p className="mt-1.5 text-[12px] text-ink-soft">
          The report shows <span className="font-medium text-ink-mid">File A − File B</span> for every row.
        </p>
      ) : (
        <p className="num mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
          <span className="text-ink-mid">{money(a)}</span>
          <span className="text-ink-soft">−</span>
          <span className="text-ink-mid">{money(b)}</span>
          <span className="text-ink-soft">=</span>
          <span className={cx('font-semibold', gap === 0 ? 'text-ok' : breaks ? 'text-bad' : 'text-warn')}>
            {gap === 0 ? '₹0.00' : `${gap > 0 ? '−' : '+'}${money(gap)}`}
          </span>
          <span className="font-sans text-[11px] text-ink-soft">
            {gap === 0 ? 'equal' : breaks ? 'would be a break' : 'inside tolerance'} · sample values, not a matched pair
          </span>
        </p>
      )}
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-soft">{toleranceSentence(pair)}</p>
    </div>
  );
}

/**
 * One date side: which format was detected, how it was detected, and the
 * override. The detected format is the thing a finance user needs to see, so it
 * is on the surface rather than in a tooltip.
 */
function DateSide({ side, file, column, profile, value, onChange }) {
  const detected = profile?.dateFormat ? DATE_FORMAT_LABEL[profile.dateFormat] || profile.dateFormat : null;
  const using = value === 'auto' ? detected : DATE_FORMAT_LABEL[value] || value;

  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="eyebrow flex items-center gap-1.5"><CalendarDays className="size-3" /> File {side} · {column || '—'}</p>
        <Badge tone={profile?.dateAmbiguous && value === 'auto' ? 'warn' : using ? 'ok' : 'neutral'}>
          {using || 'not detected'}
        </Badge>
      </div>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-soft">
        {value === 'auto'
          ? (profile?.dateReason || 'No date format found in this column yet.')
          : 'Dates are read with the format you picked.'}
      </p>
      {profile?.samples?.length ? (
        <p className="num mt-1 text-[11px] text-ink-soft">{profile.samples.slice(0, 3).join(' · ')}</p>
      ) : null}
      <div className="mt-2">
        <Select value={value} options={DATE_FORMATS} onChange={(e) => onChange(e.target.value)} />
      </div>
    </div>
  );
}

function PairRow({ pair, index, fileA, fileB, thresholds, onChange, onRemove }) {
  const pA = profileOf(fileA, pair.colA);
  const pB = profileOf(fileB, pair.colB);
  const effectiveType = resolveEffectiveType(pair, pA, pB);
  const ambiguous = effectiveType === 'date' && (pA?.dateAmbiguous || pB?.dateAmbiguous)
    && pair.dateFormatA === 'auto' && pair.dateFormatB === 'auto';

  return (
    <div className="rounded-xl border border-line bg-surface-2">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="num text-[11px] font-semibold text-ink-soft">Rule {index + 1}</span>
          <Badge tone={TYPE_TONE[effectiveType] || 'neutral'}>{effectiveType}</Badge>
          {pair.type === 'auto' && <span className="text-[11px] text-ink-soft">found automatically</span>}
        </div>
        <Button variant="ghost" size="sm" onClick={onRemove} aria-label={`Remove field ${index + 1}`}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      <div className="space-y-3 p-3">
        <div className="grid items-end gap-2.5 md:grid-cols-[1fr_1fr_170px]">
          <Field label="File A column">
            <Select value={pair.colA} options={fileA.headers} placeholder="Choose column" onChange={(e) => onChange({ colA: e.target.value })} />
          </Field>
          <Field label="File B column">
            <Select value={pair.colB} options={fileB.headers} placeholder="Choose column" onChange={(e) => onChange({ colB: e.target.value })} />
          </Field>
          <Field label="Compare as">
            <Select value={pair.type} options={TYPE_OPTIONS} onChange={(e) => onChange({ type: e.target.value })} />
          </Field>
        </div>

        {effectiveType === 'amount' && (
          <div className="space-y-2.5">
            <div className="grid gap-2.5 md:grid-cols-3">
              <Field label="Allowed difference (₹)"><NumberInput value={pair.absTol} onChange={(v) => onChange({ absTol: v })} /></Field>
              <Field label="Allowed difference (%)"><NumberInput value={pair.pctTol} onChange={(v) => onChange({ pctTol: v })} /></Field>
              <div className="pb-1 pt-6">
                <Toggle checked={pair.ignoreSign} onChange={(v) => onChange({ ignoreSign: v })} label="Ignore + and − sign" hint="Order +1500 vs Tally 1500 Cr" />
              </div>
            </div>
            <AmountPreview pair={pair} pA={pA} pB={pB} />
          </div>
        )}

        {effectiveType === 'date' && (
          <div className="space-y-2.5">
            <div className="grid gap-2.5 md:grid-cols-2">
              <DateSide side="A" file={fileA} column={pair.colA} profile={pA} value={pair.dateFormatA} onChange={(v) => onChange({ dateFormatA: v })} />
              <DateSide side="B" file={fileB} column={pair.colB} profile={pB} value={pair.dateFormatB} onChange={(v) => onChange({ dateFormatB: v })} />
            </div>
            <div className="grid gap-2.5 md:grid-cols-2">
              <Field label="Allow days earlier in B" hint="0 means the dates must be the same day">
                <NumberInput value={pair.dateBefore} onChange={(v) => onChange({ dateBefore: v })} />
              </Field>
              <Field label="Allow days later in B" hint="Example: B date is 2 days after A, enter 2">
                <NumberInput value={pair.dateAfter} onChange={(v) => onChange({ dateAfter: v })} />
              </Field>
            </div>
            <p className="text-[11.5px] text-ink-soft">
              The result shows File A date minus File B date in days. 0 means the same day.
            </p>
            {ambiguous && (
              <Banner tone="warn" title="This date column can be read as DD/MM or MM/DD">
                Please pick the date format for each file.
              </Banner>
            )}
          </div>
        )}

        {effectiveType === 'text' && (
          <div className="space-y-2.5">
            <div className="flex items-start gap-2.5 rounded-lg border border-accent/20 bg-accent-soft px-3 py-2.5">
              <Wand2 className="mt-0.5 size-4 shrink-0 text-accent" />
              <p className="text-[12px] leading-relaxed text-accent-ink">
                Text is compared automatically. Each pair gets a similarity %: <span className="num font-semibold">{thresholds.match}% or more</span> similar →{' '}
                <span className="font-semibold">Matched</span>, <span className="num font-semibold">below {thresholds.match}%</span> →{' '}
                <span className="font-semibold">Mismatched</span>. Your values are never changed.
              </p>
            </div>
            <div className="grid gap-2.5 md:grid-cols-2">
              <Toggle checked={pair.caseSensitive} onChange={(v) => onChange({ caseSensitive: v })} label="Case sensitive" hint="When off, ABC Traders and abc traders are the same" />
              <Toggle checked={pair.required !== false} onChange={(v) => onChange({ required: v })} label="A difference here makes the row Mismatched" hint="Turn off to only show this field" />
            </div>
          </div>
        )}

        {effectiveType === 'identifier' && (
          <p className="rounded-lg border border-line bg-surface px-3 py-2.5 text-[12px] leading-relaxed text-ink-soft">
            ID numbers must be exactly the same (spaces, dashes and capital letters are ignored). There is no similarity % for IDs.
          </p>
        )}

        <p className="num flex flex-wrap gap-x-2 text-[11px] text-ink-soft">
          <span>A: {pA?.samples?.slice(0, 2).join(' · ') || '—'}</span>
          <span aria-hidden>→</span>
          <span>B: {pB?.samples?.slice(0, 2).join(' · ') || '—'}</span>
        </p>
      </div>
    </div>
  );
}

function KeyRules({ label, rules, onChange }) {
  return (
    <div className="space-y-2.5">
      <p className="eyebrow">{label}</p>
      <div className="grid gap-2.5 md:grid-cols-2">
        <Field label="Remove text at the start" hint='e.g. "OD" turns OD5501 into 5501'>
          <Input value={rules.prefix || ''} onChange={(e) => onChange({ prefix: e.target.value })} placeholder="none" />
        </Field>
        <Field label="Take part of the ID (pattern)" hint="Advanced: regular expression">
          <Input value={rules.extract || ''} onChange={(e) => onChange({ extract: e.target.value })} placeholder="none" />
        </Field>
      </div>
      <Toggle checked={rules.stripSeparators !== false} onChange={(v) => onChange({ stripSeparators: v })} label="Ignore spaces, dashes and slashes" hint="INV-001 and inv 001 are treated as the same ID" />
      <Toggle checked={!!rules.dropLeadingZeros} onChange={(v) => onChange({ dropLeadingZeros: v })} label="Ignore leading zeros" hint="00123 becomes 123" />
    </div>
  );
}

/**
 * What the engine worked out on its own, with the evidence behind each choice.
 * Every line is a counted fact from the last run, not a guess about it.
 */
function DetectedCard({ detected }) {
  if (!detected?.decisions?.length) return null;
  const e = detected.evidence || {};
  return (
    <Card
      title="What the app found automatically"
      subtitle="From your last run. Any change you make below is saved."
    >
      <ul className="space-y-2">
        {detected.decisions.map((d, i) => (
          <li key={`${d.what}-${i}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12.5px]">
            <Sparkles className="mt-0.5 size-3.5 shrink-0 text-accent" />
            <span className="font-medium text-ink">{d.what}:</span>
            <span className="num text-ink">{d.chose}</span>
            <span className="text-ink-soft">— {d.why}</span>
          </li>
        ))}
      </ul>
      {(e.prefixA || e.prefixB || e.weak) && (
        <div className="mt-3 space-y-1 border-t border-line pt-3 text-[12px] text-ink-soft">
          {e.prefixA && <p>In File A, the app ignored the start text <span className="num">{e.prefixA}</span>. Your file is not changed.</p>}
          {e.prefixB && <p>In File B, the app ignored the start text <span className="num">{e.prefixB}</span>. Your file is not changed.</p>}
          {e.weak && <p className="text-warn">The Order ID columns do not match well. Please check them below.</p>}
        </div>
      )}
    </Card>
  );
}

export default function Rules({
  fileA, fileB, settings, setSettings, onBack, onRun, running,
  onAutoRun, ruleSource = 'auto', onUseAutomatic, markEdited, detected,
}) {
  const update = (patch) => { markEdited?.(); setSettings({ ...settings, ...patch }); };
  const updatePair = (id, patch) => update({ pairs: settings.pairs.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  // One number: the match line. 50% by default; adjustable under Advanced.
  const thresholds = normalizeThresholds(settings.textThresholds);

  const addPair = () => update({
    pairs: [...settings.pairs, {
      id: `p${Date.now()}`, colA: '', colB: '', type: 'auto',
      absTol: 0, pctTol: 0, dateBefore: 0, dateAfter: 0,
      dateFormatA: 'auto', dateFormatB: 'auto', ignoreSign: false, caseSensitive: false, required: true,
    }],
  });

  const problems = useMemo(() => {
    const list = [];
    if (!settings.keyA || !settings.keyB) list.push('Choose the Order ID column in both files, or press Auto setup and compare.');
    const usable = settings.pairs.filter((p) => p.colA && p.colB);
    if (!usable.length) list.push('Add at least one field to compare.');
    const keyProfileA = profileOf(fileA, settings.keyA);
    if (keyProfileA?.blanks) list.push(`${keyProfileA.blanks.toLocaleString('en-IN')} rows in file A have a blank key — they will be listed as excluded, not dropped.`);
    return list;
  }, [settings, fileA]);

  const canRun = settings.keyA && settings.keyB && settings.pairs.some((p) => p.colA && p.colB) && !running;

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div>
        <p className="eyebrow">Step 2 (optional)</p>
        <h2 className="mt-1 text-[19px] font-semibold tracking-tight">Check the comparison settings</h2>
        <p className="mt-1 max-w-2xl text-[13px] text-ink-soft">
          You can skip this step. The app finds the Order ID columns and the fields to compare by itself.
          Change something here only if the results look wrong.
        </p>
      </div>

      {!settings.keyA && (
        <Banner
          tone="info"
          title="Everything is set automatically"
          action={<Button size="sm" variant="primary" onClick={onAutoRun} disabled={running}><Play className="size-3.5" /> Auto setup and compare</Button>}
        >
          The app can find the Order ID columns and the fields to compare from your two files.
          You can change anything here later. Your changes are saved for the next files with the same columns.
        </Banner>
      )}

      {ruleSource === 'remembered' && (
        <Banner
          tone="info"
          title="Using your saved settings for these columns"
          action={<Button size="sm" variant="ghost" onClick={onUseAutomatic}>Reset to automatic</Button>}
        >
          You changed these settings last time for files with the same columns.
        </Banner>
      )}

      <DetectedCard detected={detected} />

      <Card title="Order ID columns" subtitle="The column used to find the same order in File A and File B">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={`Order ID column in ${fileA.name}`}>
            <Select value={settings.keyA} options={fileA.headers} placeholder="Choose column" onChange={(e) => update({ keyA: e.target.value })} />
          </Field>
          <Field label={`Order ID column in ${fileB.name}`}>
            <Select value={settings.keyB} options={fileB.headers} placeholder="Choose column" onChange={(e) => update({ keyB: e.target.value })} />
          </Field>
        </div>
      </Card>

      <Card
        title="Fields to compare"
        subtitle={`${settings.pairs.length} field${settings.pairs.length === 1 ? '' : 's'}`}
        action={<Button size="sm" onClick={addPair}><Plus className="size-3.5" /> Add field</Button>}
        bodyClassName="p-3 md:p-4"
      >
        <div className="space-y-3">
          {settings.pairs.length === 0 && (
            <p className="rounded-xl border border-dashed border-line-strong bg-surface-2 px-4 py-8 text-center text-[13px] text-ink-soft">
              No fields to compare yet. Add one to start.
            </p>
          )}
          {settings.pairs.map((pair, i) => (
            <PairRow
              key={pair.id}
              pair={pair}
              index={i}
              fileA={fileA}
              fileB={fileB}
              thresholds={thresholds}
              onChange={(patch) => updatePair(pair.id, patch)}
              onRemove={() => update({ pairs: settings.pairs.filter((p) => p.id !== pair.id) })}
            />
          ))}
        </div>
      </Card>

      <Disclosure label="More settings">
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-[220px_1fr] md:items-end">
            <Field label="Text match level (%)" hint="This % or more is Matched. Default is 50.">
              <NumberInput
                min={0}
                max={100}
                step={1}
                value={thresholds.match}
                onChange={(v) => update({ textThresholds: normalizeThresholds({ match: v }) })}
              />
            </Field>
            <p className="pb-2 text-[12px] leading-relaxed text-ink-soft">
              Names that are {thresholds.match}% or more similar (for example <span className="num">ABC Traders</span> vs{' '}
              <span className="num">ABC Trader</span>) are reported as <span className="font-medium text-ok">Matched</span>; anything less
              similar is <span className="font-medium text-bad">Mismatched</span>.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <KeyRules label={`Order ID clean-up: ${fileA.name}`} rules={settings.keyRulesA} onChange={(patch) => update({ keyRulesA: { ...settings.keyRulesA, ...patch } })} />
            <KeyRules label={`Order ID clean-up: ${fileB.name}`} rules={settings.keyRulesB} onChange={(patch) => update({ keyRulesB: { ...settings.keyRulesB, ...patch } })} />
          </div>
          <div className="grid gap-3 border-t border-line pt-3.5 md:grid-cols-2">
            <Toggle
              checked={settings.groupMatching}
              onChange={(v) => update({ groupMatching: v })}
              label="Match one order to many rows"
              hint="One File A row against several File B rows when the amounts add up"
            />
            <Field label="Allowed difference for groups" hint="Keep at 0 unless you need to allow small rounding">
              <NumberInput value={settings.groupTolerance} onChange={(v) => update({ groupTolerance: v })} />
            </Field>
            <Toggle
              checked={settings.dateAmountFallback}
              onChange={(v) => update({ dateAmountFallback: v })}
              label="Also match by date and amount"
              hint="Only for rows with no matching Order ID"
            />
            <Toggle
              checked={settings.crIsNegative !== false}
              onChange={(v) => update({ crIsNegative: v })}
              label="Read Cr amounts as negative"
              hint='"1,500.00 Cr" is read as −1500'
            />
          </div>
        </div>
      </Disclosure>

      {problems.length > 0 && (
        <Banner tone="warn" title="Before you compare">
          <ul className="mt-1 list-disc space-y-0.5 pl-4">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </Banner>
      )}

      <div className={cx(
        'sticky bottom-0 -mx-4 mt-auto flex items-center justify-between gap-3 border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6',
      )}
      >
        <Button variant="ghost" onClick={onBack}>Back to upload</Button>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="lg" onClick={onAutoRun} disabled={running}>
            <Wand2 className="size-4" /> Auto setup and compare
          </Button>
          <Button variant="primary" size="lg" disabled={!canRun} onClick={onRun}>
            {running ? 'Comparing…' : <>Compare with these settings <ArrowRight className="size-4" /></>}
          </Button>
        </div>
      </div>
    </div>
  );
}
