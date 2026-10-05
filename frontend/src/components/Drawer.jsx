import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { Button } from './Primitives.jsx';

/** Right-side drawer: keeps the grid visible, traps focus, restores it on close. */
export default function Drawer({ open, title, subtitle, onClose, children, footer }) {
  const panel = useRef(null);
  const restoreTo = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    restoreTo.current = document.activeElement;
    const node = panel.current;
    node?.querySelector('[data-autofocus]')?.focus() ?? node?.focus();

    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab' || !node) return;
      const items = [...node.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.disabled && el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };

    document.addEventListener('keydown', onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = overflow;
      restoreTo.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button type="button" aria-label="Close details" className="flex-1 bg-shell/25 backdrop-blur-[1px]" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="flex h-full w-full max-w-[600px] flex-col border-l border-line bg-surface shadow-[-8px_0_32px_rgba(16,23,37,0.12)]"
      >
        <header className="flex items-start justify-between gap-3 border-b border-line bg-surface-2 px-4 py-3">
          <div className="min-w-0">
            <h2 className="mono truncate text-[14px] font-semibold">{title}</h2>
            {subtitle && <p className="truncate text-[12px] text-ink-soft">{subtitle}</p>}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} data-autofocus aria-label="Close details">
            <X className="size-4" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer && <footer className="border-t border-line px-4 py-3">{footer}</footer>}
      </div>
    </div>
  );
}
