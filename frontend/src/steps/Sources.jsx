import { useRef, useState } from 'react';
import { FileSpreadsheet, Upload, RotateCcw, ArrowRight, Check, Play, Wand2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { Badge, Button, Card, Disclosure, Field, Select, Banner } from '../components/Primitives.jsx';
import { cx, fmtBytes, fmtInt } from '../lib/ui.js';

function SourceCard({ side, label, file, onFile, onView, onClear }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);

  const upload = async (picked) => {
    if (!picked) return;
    setBusy(true); setError(null);
    try { onFile(await api.uploadFile(picked)); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const changeView = async (patch) => {
    setBusy(true); setError(null);
    try { onView(await api.setView(file.fileId, patch)); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <Card
      title={label}
      subtitle={side}
      action={file
        ? <Button variant="ghost" size="sm" onClick={onClear}><RotateCcw className="size-3.5" /> Replace</Button>
        : <Badge>Required</Badge>}
    >
      {!file ? (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files?.[0]); }}
          className={cx(
            'rounded-xl border border-dashed px-5 py-10 text-center transition-colors',
            dragging ? 'border-accent bg-accent-soft' : 'border-line-strong bg-surface-2',
          )}
        >
          <span className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent">
            <Upload className="size-4.5" />
          </span>
          <p className="text-[13.5px] font-medium text-ink">Drop your Excel or CSV file here</p>
          <p className="mt-0.5 text-[12px] text-ink-soft">or click the button</p>
          <Button className="mt-3.5" onClick={() => input.current?.click()} disabled={busy}>
            {busy ? 'Reading…' : 'Choose file'}
          </Button>
          <input
            ref={input}
            type="file"
            accept=".xlsx,.xls,.xlsm,.csv"
            className="sr-only"
            onChange={(e) => upload(e.target.files?.[0])}
          />
          <p className="mt-3 text-[11px] text-ink-soft">.xlsx, .xls, .xlsm or .csv, up to 80 MB. Your file is not changed.</p>
        </div>
      ) : (
        <div className="space-y-3.5">
          <div className="flex items-start gap-2.5 rounded-lg border border-line bg-surface-2 px-3 py-2.5">
            <FileSpreadsheet className="mt-0.5 size-4 shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium">{file.name}</p>
              <p className="num text-[11.5px] text-ink-soft">
                {fmtInt(file.totalRows)} rows · {file.totalCols} columns · {fmtBytes(file.size)}
              </p>
            </div>
            <Check className="mt-0.5 size-4 shrink-0 text-ok" />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Sheet">
              <Select
                value={file.selectedSheet}
                options={file.sheetNames}
                disabled={busy}
                onChange={(e) => changeView({ sheetName: e.target.value })}
              />
            </Field>
            <Field label="Header row" hint={file.headerRowIndex === file.guessedHeaderRow ? 'Detected automatically' : 'Changed manually'}>
              <Select
                value={String(file.headerRowIndex)}
                disabled={busy}
                options={file.preview.slice(0, 20).map((row, i) => ({
                  value: String(i),
                  label: `Row ${i + 1}: ${row.filter(Boolean).slice(0, 4).join(' | ').slice(0, 48) || '(empty)'}`,
                }))}
                onChange={(e) => changeView({ sheetName: file.selectedSheet, headerRowIndex: Number(e.target.value) })}
              />
            </Field>
          </div>

          {file.date1904 && (
            <Banner tone="warn" title="1904 date system">
              This file was made on a Mac. Dates are adjusted so they stay correct.
            </Banner>
          )}

          <Disclosure label="Preview first rows">
            <div className="-mx-1 overflow-x-auto">
              <table className="w-full text-[12px]">
                <tbody>
                  {file.preview.slice(0, 12).map((row, r) => (
                    <tr key={r} className={cx('border-b border-line/70 last:border-0', r === file.headerRowIndex && 'bg-accent-soft font-medium')}>
                      {row.slice(0, 8).map((cell, c) => (
                        <td key={c} className="max-w-[150px] truncate px-2 py-1.5">{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Disclosure>
        </div>
      )}

      {error && <p className="mt-3 text-[12px] text-bad">{error}</p>}
    </Card>
  );
}

export default function Sources({ fileA, fileB, setFileA, setFileB, onNext, onRun, ruleSource, onUseAutomatic }) {
  const ready = fileA && fileB;
  const remembered = ruleSource === 'remembered';
  return (
    <div className="flex flex-1 flex-col gap-4">
      <div>
        <p className="eyebrow">Step 1 of 3</p>
        <h2 className="mt-1 text-[19px] font-semibold tracking-tight">Upload your two files</h2>
        <p className="mt-1 max-w-2xl text-[13px] text-ink-soft">
          One file from your orders and one from Tally. Then press <span className="font-medium text-ink">Compare files</span>.
          Rows are matched by Order ID and shown as <span className="font-medium text-ok">Matched</span>,{' '}
          <span className="font-medium text-bad">Mismatched</span>, Only in File A or Only in File B.
        </p>
      </div>

      <ol className="grid gap-2 text-[12.5px] text-ink-soft sm:grid-cols-3">
        {[
          ['1', 'Upload both files', 'Excel or CSV files.'],
          ['2', 'Press Compare files', 'Text 50% or more similar is Matched, below is Mismatched. Dates must be the same day.'],
          ['3', 'Download the Excel', '5 sheets: All Data, Matched, Mismatched, Only in File A, Only in File B.'],
        ].map(([n, title, sub]) => (
          <li key={n} className="flex items-start gap-2.5 rounded-xl border border-line bg-surface px-3 py-2.5">
            <span className="num mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent-ink">{n}</span>
            <span className="min-w-0">
              <span className="block font-medium text-ink">{title}</span>
              <span className="block text-[11.5px] leading-snug">{sub}</span>
            </span>
          </li>
        ))}
      </ol>

      <div className="grid gap-4 lg:grid-cols-2">
        <SourceCard side="File A" label="Orders file" file={fileA} onFile={setFileA} onView={setFileA} onClear={() => setFileA(null)} />
        <SourceCard side="File B" label="Tally / ledger file" file={fileB} onFile={setFileB} onView={setFileB} onClear={() => setFileB(null)} />
      </div>

      {ready && remembered && (
        <Banner
          tone="info"
          title="Using your saved settings for these columns"
          action={<Button size="sm" variant="ghost" onClick={onUseAutomatic}>Reset to automatic</Button>}
        >
          You changed the settings last time for files with the same columns, so those settings are used.
          Press Reset to automatic to let the app set everything again.
        </Banner>
      )}

      <div className="sticky bottom-0 -mx-4 mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
        <p className="flex items-center gap-1.5 text-[12.5px] text-ink-soft">
          {ready
            ? remembered
              ? <><Check className="size-3.5 text-ok" /> Both files are ready. Your saved settings will be used.</>
              : <><Wand2 className="size-3.5 text-accent" /> Both files are ready to compare.</>
            : 'Upload both files to continue'}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="lg" disabled={!ready} onClick={onNext}>
            Check settings first <ArrowRight className="size-4" />
          </Button>
          <Button variant="primary" size="lg" disabled={!ready} onClick={onRun}>
            <Play className="size-4" /> Compare files
          </Button>
        </div>
      </div>
    </div>
  );
}
