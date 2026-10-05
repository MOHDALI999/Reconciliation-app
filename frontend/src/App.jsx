import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import Sources from './steps/Sources.jsx';
import Rules from './steps/Rules.jsx';
import Review from './steps/Review.jsx';
import { Banner, Button, Logo, Progress } from './components/Primitives.jsx';
import { api, subscribeRun } from './lib/api.js';
import { clearSession, cx, loadSession, normalizeThresholds, saveSession } from './lib/ui.js';
import { cleanSettings, fingerprint, forgetRules, recallRules, rememberRules } from './lib/memory.js';

const STEPS = [
  { id: 'sources', label: 'Upload files', hint: 'Pick the two files' },
  { id: 'rules', label: 'Check settings', hint: 'Optional' },
  { id: 'review', label: 'Results', hint: 'See and download results' },
];

const DEFAULT_SETTINGS = {
  keyA: '',
  keyB: '',
  keyRulesA: { stripSeparators: true, caseFold: true, prefix: '', extract: '', dropLeadingZeros: false },
  keyRulesB: { stripSeparators: true, caseFold: true, prefix: '', extract: '', dropLeadingZeros: false },
  pairs: [],
  groupMatching: false,
  groupTolerance: 0,
  dateAmountFallback: false,
  crIsNegative: true,
  currency: '₹',
  // Text rule: similarity >= 50% -> Match, < 50% -> Not Match.
  textThresholds: { match: 50 },
};

/** Settings coming back from storage or a run, with the text rule in its current shape. */
const withSafeThresholds = (s) => ({ ...s, textThresholds: normalizeThresholds(s?.textThresholds) });

const NEW_PAIR = {
  colA: '', colB: '', type: 'auto',
  absTol: 0, pctTol: 0, dateBefore: 0, dateAfter: 0,
  dateFormatA: 'auto', dateFormatB: 'auto', ignoreSign: false, caseSensitive: false, required: true,
};

/** Editable pair fields only — the resolved pairs that come back from a run
 * carry detection metadata that the run schema does not accept. */
const EDITABLE_PAIR = (p, i) => ({
  ...NEW_PAIR,
  id: p.id || `p${i + 1}`,
  colA: p.colA, colB: p.colB,
  type: p.type || 'auto',
  absTol: p.absTol ?? 0, pctTol: p.pctTol ?? 0,
  dateBefore: p.dateBefore ?? 0, dateAfter: p.dateAfter ?? 0,
  dateFormatA: p.dateFormatA || 'auto', dateFormatB: p.dateFormatB || 'auto',
  ignoreSign: !!p.ignoreSign, caseSensitive: !!p.caseSensitive,
  required: p.required !== false,
});

function Stepper({ step, stepIndex, canJump, onJump }) {
  return (
    <ol className="flex items-center gap-1" aria-label="Progress">
      {STEPS.map((s, i) => {
        const state = i < stepIndex ? 'done' : i === stepIndex ? 'current' : 'todo';
        const reachable = canJump(i);
        return (
          <li key={s.id} className="flex items-center gap-1">
            <button
              type="button"
              disabled={!reachable}
              aria-label={`${i + 1}. ${s.label} — ${s.hint}`}
              aria-current={step === s.id ? 'step' : undefined}
              onClick={() => onJump(s.id)}
              className={cx(
                'group flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors disabled:cursor-not-allowed',
                state === 'current' ? 'bg-white/12' : reachable ? 'hover:bg-white/8' : 'opacity-45',
              )}
            >
              <span className={cx(
                'num flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                state === 'current' ? 'bg-white text-shell' : state === 'done' ? 'bg-white/25 text-white' : 'border border-white/25 text-white/60',
              )}
              >
                {state === 'done' ? <Check className="size-3" strokeWidth={3} /> : i + 1}
              </span>
              <span className="hidden sm:block">
                <span className={cx('block text-[12.5px] font-medium leading-none', state === 'todo' ? 'text-white/55' : 'text-white')}>{s.label}</span>
              </span>
            </button>
            {i < STEPS.length - 1 && <span className="h-px w-4 bg-white/20 sm:w-6" />}
          </li>
        );
      })}
    </ol>
  );
}

export default function App() {
  const [step, setStep] = useState('sources');
  const [fileA, setFileA] = useState(null);
  const [fileB, setFileB] = useState(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [run, setRun] = useState(null);       // { runId, status, progress, summary, stats, error }
  const [error, setError] = useState(null);
  // 'auto'      — nothing set by hand, the engine decides from the data
  // 'remembered'— rules this user saved last time for files of this shape
  // 'manual'    — rules edited in this session
  const [ruleSource, setRuleSource] = useState('auto');
  const unsubscribe = useRef(null);
  const fp = fingerprint(fileA, fileB);

  // Restore only ids and settings — row data never leaves the server.
  useEffect(() => {
    const saved = loadSession();
    if (saved?.settings) setSettings(withSafeThresholds({ ...DEFAULT_SETTINGS, ...saved.settings }));
  }, []);

  useEffect(() => {
    saveSession({ settings, step });
  }, [settings, step]);

  useEffect(() => () => unsubscribe.current?.(), []);

  // As soon as both sides are loaded, look for rules this user saved for files
  // of this shape. Nothing found means the run stays fully automatic.
  useEffect(() => {
    if (!fileA || !fileB) return;
    if (ruleSource === 'manual') return;
    const saved = recallRules(fp);
    if (saved) {
      setSettings(withSafeThresholds({ ...DEFAULT_SETTINGS, ...saved.settings }));
      setRuleSource('remembered');
    } else {
      setSettings((s) => ({ ...DEFAULT_SETTINGS, currency: s.currency }));
      setRuleSource('auto');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fp]);

  const onFileA = useCallback((file) => setFileA(file), []);
  const onFileB = useCallback((file) => setFileB(file), []);

  const useAutomatic = () => {
    forgetRules(fp);
    setSettings((s) => ({ ...DEFAULT_SETTINGS, currency: s.currency }));
    setRuleSource('auto');
  };

  /**
   * Start a run. `mode` is 'auto' for the one-click path (the engine derives the
   * key, its clean-up and the comparison rules from the data) or 'manual' when
   * the rules screen has been used — then the rules are also remembered for the
   * next upload of files with the same columns.
   */
  const startRun = async (mode = ruleSource === 'auto' ? 'auto' : 'manual') => {
    setError(null);
    const automatic = mode === 'auto';
    if (!automatic) rememberRules(fp, settings);
    if (automatic) setRuleSource('auto');
    try {
      const payload = cleanSettings(settings);
      if (automatic) { delete payload.keyA; delete payload.keyB; delete payload.keyRulesA; delete payload.keyRulesB; payload.pairs = []; }
      const { runId } = await api.startRun({
        fileIdA: fileA.fileId,
        fileIdB: fileB.fileId,
        settings: automatic ? { ...payload, auto: true } : payload,
      });
      setRun({ runId, status: 'running', progress: { phase: 'starting', done: 0 } });
      setStep('review');
      unsubscribe.current?.();
      unsubscribe.current = subscribeRun(runId, (state) => {
        setRun((prev) => ({ ...prev, ...state }));
        if (state.status === 'failed') setError(state.error || 'Something went wrong. Please try again.');
        // Adopt whatever actually ran, so the rules screen shows the detected
        // key, clean-up and field rules — ready to be adjusted.
        if (state.status === 'ready' && state.summary) {
          setSettings((s) => withSafeThresholds({
            ...s,
            ...state.summary.settings,
            pairs: (state.summary.pairs || []).map(EDITABLE_PAIR),
          }));
        }
      });
    } catch (err) {
      setError(err.message);
    }
  };

  const cancelRun = async () => {
    if (run?.runId) await api.cancelRun(run.runId).catch(() => {});
    unsubscribe.current?.();
    setRun(null);
    setStep('rules');
  };

  const restart = () => {
    unsubscribe.current?.();
    if (run?.runId) api.cancelRun(run.runId).catch(() => {});
    setRun(null);
    setStep('rules');
  };

  const resetAll = () => {
    unsubscribe.current?.();
    clearSession();
    setFileA(null); setFileB(null); setRun(null); setError(null);
    setSettings(DEFAULT_SETTINGS);
    setRuleSource('auto');
    setStep('sources');
  };

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const canJump = (i) => i === 0 || (i === 1 && !!(fileA && fileB)) || (i === 2 && !!run);
  const wide = step === 'review' && run?.status === 'ready';

  return (
    <div className="flex h-full flex-col bg-canvas">
      <header className="shrink-0 bg-shell text-white">
        <div className="mx-auto flex h-14 w-full max-w-[1640px] items-center gap-4 px-4 md:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <Logo className="size-7 shrink-0 text-accent" />
            <div className="min-w-0">
              <h1 className="truncate text-[14px] font-semibold leading-tight">Order vs Tally reconciliation</h1>
              <p className="hidden truncate text-[11.5px] text-white/55 sm:block">Upload two files, match by Order ID, download the results</p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2 md:gap-4">
            <Stepper step={step} stepIndex={stepIndex} canJump={canJump} onJump={setStep} />
            <span className="hidden h-6 w-px bg-white/15 md:block" />
            <Button variant="quiet" size="sm" onClick={resetAll} aria-label="Start over">
              <RotateCcw className="size-3.5" />
              <span className="hidden md:inline">Start over</span>
            </Button>
          </div>
        </div>
      </header>

      <main className={cx('flex min-h-0 flex-1 flex-col', wide ? 'overflow-y-auto lg:overflow-hidden' : 'overflow-y-auto')}>
        <div
          className={cx(
            'mx-auto flex w-full flex-1 flex-col gap-4 px-4 py-5 md:px-6 md:py-6',
            wide ? 'max-w-[1640px] lg:min-h-0' : 'max-w-[1120px]',
          )}
        >
          {error && <Banner tone="bad" title="Something went wrong">{error}</Banner>}

          {step === 'sources' && (
            <Sources
              fileA={fileA}
              fileB={fileB}
              setFileA={onFileA}
              setFileB={onFileB}
              onNext={() => setStep('rules')}
              onRun={() => startRun('auto')}
              ruleSource={ruleSource}
              onUseAutomatic={useAutomatic}
            />
          )}

          {step === 'rules' && fileA && fileB && (
            <Rules
              fileA={fileA}
              fileB={fileB}
              settings={settings}
              setSettings={setSettings}
              onBack={() => setStep('sources')}
              onRun={() => startRun('manual')}
              onAutoRun={() => startRun('auto')}
              ruleSource={ruleSource}
              onUseAutomatic={useAutomatic}
              markEdited={() => setRuleSource('manual')}
              detected={run?.summary?.plan || null}
              running={run?.status === 'running'}
            />
          )}

          {step === 'rules' && (!fileA || !fileB) && (
            <Banner tone="warn" title="Load both files first" action={<Button size="sm" onClick={() => setStep('sources')}>Go to upload</Button>} />
          )}

          {step === 'review' && run?.status === 'running' && (
            <div className="mx-auto mt-12 w-full max-w-md space-y-3 rounded-xl border border-line bg-surface p-5 shadow-[0_1px_3px_rgba(16,23,37,0.05)]">
              <p className="text-[13.5px] font-semibold">Comparing your files…</p>
              <Progress
                value={run.progress?.done}
                label={`${run.progress?.phase || 'working'} — this usually takes a few seconds`}
              />
              <Button variant="danger" size="sm" onClick={cancelRun}>Stop</Button>
            </div>
          )}

          {step === 'review' && run?.status === 'ready' && (
            <Review
              runId={run.runId}
              summary={run.summary}
              stats={run.stats}
              onRestart={restart}
              ruleSource={ruleSource}
              onAdjust={() => setStep('rules')}
            />
          )}

          {step === 'review' && run?.status === 'failed' && (
            <Banner tone="bad" title="Something went wrong" action={<Button size="sm" onClick={() => setStep('rules')}>Back to settings</Button>}>
              {run.error}
            </Banner>
          )}
        </div>
      </main>
    </div>
  );
}
