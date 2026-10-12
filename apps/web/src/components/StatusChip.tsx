import type { ReactNode } from 'react';
import './StatusChip.css';

/** Short state label. Meaning is always in the text; tone only adds emphasis
 *  (and is dropped in e-ink, where chips are plain outlined text). */
export function StatusChip({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'attention' | 'danger';
  children: ReactNode;
}) {
  return <span className={`chip chip--${tone}`}>{children}</span>;
}
