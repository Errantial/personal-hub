/* Line icons drawn with strokes only, so they stay crisp on e-ink.
   Always decorative: the adjacent label names the control. */
const paths = {
  today:
    'M12 3v2M12 19v2M5 12H3M21 12h-2M6.3 6.3 4.9 4.9M19.1 19.1l-1.4-1.4M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  tasks: 'M4 5h4v4H4zM4 15h4v4H4zM11 7h9M11 17h9M5 7l1 1 2-2',
  classes: 'M4 5c3-1 6-1 8 1 2-2 5-2 8-1v14c-3-1-6-1-8 1-2-2-5-2-8-1zM12 6v14',
  inbox: 'M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5',
  settings:
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  eink: 'M6 3h12v18H6zM9 7h6M9 11h6M9 15h3',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' ? 3 : 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}
