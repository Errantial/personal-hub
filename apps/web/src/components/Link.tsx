import type { ReactNode } from 'react';
import { routePath } from '../lib/router';
import type { Route } from '../lib/router';

/** In-app link: a real anchor (middle-click, copy address, screen readers)
 *  that navigates through the History API on a plain click. */
export function Link({
  route,
  navigate,
  current = false,
  className,
  children,
  onNavigate,
}: {
  route: Route;
  navigate: (route: Route) => void;
  current?: boolean;
  className?: string;
  children: ReactNode;
  onNavigate?: () => void;
}) {
  return (
    <a
      href={routePath(route)}
      className={className}
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
