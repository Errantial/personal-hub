import type { ReactNode } from 'react';

export function Help({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <details className="context-help">
      <summary aria-label={`${label} help`}>Help</summary>
      <div>{children}</div>
    </details>
  );
}
