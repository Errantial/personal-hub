import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Toggletip (docs/ui-guidelines.md §6): a "Help" button that reveals short
 * secondary text on click, tap or Enter; Escape or a click elsewhere closes
 * it. The text is rendered into a live region only when opened, so screen
 * readers announce it on demand rather than with the button.
 */
export function Help({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    // Close on click, not pointerdown: the bubble is in the page flow, so
    // closing it before the click lands would move the control under the
    // pointer and the tap would miss it.
    const outside = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('click', outside);
    return () => document.removeEventListener('click', outside);
  }, [open]);
  return (
    <span
      className="help"
      ref={container}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        // Handled here so an enclosing disclosure stays open.
        event.preventDefault();
        setOpen(false);
        button.current?.focus();
      }}
    >
      <button
        ref={button}
        type="button"
        className="help__button"
        aria-label={`Help: ${label}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        Help
      </button>
      <span id={id} aria-live="polite" className="help__content">
        {open && <span className="help__bubble">{children}</span>}
      </span>
    </span>
  );
}
