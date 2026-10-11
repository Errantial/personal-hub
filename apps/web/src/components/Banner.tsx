import type { ReactNode } from 'react';

/** Persistent page-level message for problems the owner should act on
 *  (server unavailable, conflicts). Stays until resolved; never auto-dismissed. */
export function Banner({
  tone = 'warning',
  title,
  children,
  actions,
  label,
}: {
  tone?: 'warning' | 'danger' | 'info';
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  /** Accessible region name; also makes the banner a landmark. */
  label?: string;
}) {
  return (
    <section
      className={`banner banner--${tone}`}
      role={tone === 'info' ? 'status' : 'alert'}
      aria-label={label}
    >
      <div className="banner__body">
        <strong className="banner__title">{title}</strong>
        {children}
      </div>
      {actions && <div className="banner__actions">{actions}</div>}
    </section>
  );
}
