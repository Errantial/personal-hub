import type { CSSProperties, ReactNode } from 'react';
import { routePath } from '../lib/router';
import type { Route } from '../lib/router';

/** In-app link: a real anchor (middle-click, copy address, screen readers)
 *  that navigates through the History API on a plain click. */
export function Link({
  route,
  navigate,
  current = false,
  className,
  label,
  style,
  children,
  onNavigate,
}: {
  route: Route;
  navigate: (route: Route) => void;
  current?: boolean;
  className?: string;
  /** Accessible name when the visible text is not enough. */
  label?: string;
  style?: CSSProperties;
  children: ReactNode;
  onNavigate?: () => void;
}) {
  return (
    <a
      href={routePath(route)}
      className={className}
      aria-label={label}
      style={style}
      aria-current={current ? 'page' : undefined}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        navigate(route);
        onNavigate?.();
      }}
    >
      {children}
    </a>
  );
}
