/* Appearance: display mode, custom colors, text size, density and control
   shape, plus named profiles. Everything is device-local (localStorage) so the
   app themes before the first paint, offline and in the bundled APK.
   See docs/frontend-plan.md Phase 2b and docs/ui-guidelines.md §4. */

export const textSizes = ['small', 'default', 'large', 'larger'] as const;
export const densities = ['compact', 'comfortable', 'spacious'] as const;
export const shapes = ['square', 'rounded', 'round'] as const;
/** Light or dark palette; 'system' follows the device setting. */
export const schemes = ['system', 'light', 'dark'] as const;
export type TextSize = (typeof textSizes)[number];
export type Density = (typeof densities)[number];
export type Shape = (typeof shapes)[number];
export type Scheme = (typeof schemes)[number];

export const colorKeys = ['accent', 'background', 'surface', 'text'] as const;
export type ColorKey = (typeof colorKeys)[number];
/** Missing keys use the standard theme's color. */
export type Colors = Partial<Record<ColorKey, string>>;

export type Appearance = {
  eink: boolean;
  scheme: Scheme;
  colors: Colors;
  textSize: TextSize;
  density: Density;
  shape: Shape;
};

export type Profile = { id: string; name: string; appearance: Appearance };

export const defaultColors: Record<ColorKey, string> = {
  accent: '#284b40',
  background: '#f4f5f0',
  surface: '#ffffff',
  text: '#1f2d28',
};
export const defaultAppearance: Appearance = {
  eink: false,
  scheme: 'system',
  colors: {},
  textSize: 'default',
  density: 'comfortable',
  shape: 'rounded',
};
export const builtInProfiles: Profile[] = [
  { id: 'builtin-standard', name: 'Standard', appearance: defaultAppearance },
  {
    id: 'builtin-eink',
    name: 'E-ink',
    appearance: { ...defaultAppearance, eink: true },
  },
];
export const maxProfiles = 20;
export const maxProfileName = 40;

const hex = /^#[0-9a-f]{6}$/i;

function oneOf<T extends string>(
  allowed: readonly T[],
  value: unknown,
  fallback: T,
): T {
  return allowed.find((item) => item === value) ?? fallback;
}

/** Coerce untrusted stored data field by field; bad fields fall back. */
export function parseAppearance(value: unknown): Appearance {
  const input = (value && typeof value === 'object' ? value : {}) as Record<
    string,
    unknown
  >;
  const rawColors = (
    input.colors && typeof input.colors === 'object' ? input.colors : {}
  ) as Record<string, unknown>;
  const colors: Colors = {};
  for (const key of colorKeys) {
    const color = rawColors[key];
    if (typeof color === 'string' && hex.test(color)) {
      colors[key] = color.toLowerCase();
    }
  }
  return {
    eink: input.eink === true,
    scheme: oneOf(schemes, input.scheme, defaultAppearance.scheme),
    colors,
    textSize: oneOf(textSizes, input.textSize, defaultAppearance.textSize),
    density: oneOf(densities, input.density, defaultAppearance.density),
    shape: oneOf(shapes, input.shape, defaultAppearance.shape),
  };
}

/** Compare appearances, ignoring custom colors equal to the defaults. */
export function sameAppearance(a: Appearance, b: Appearance) {
  const resolved = (appearance: Appearance) =>
    colorKeys.map((key) => appearance.colors[key] ?? defaultColors[key]);
  return (
    a.eink === b.eink &&
    a.scheme === b.scheme &&
    a.textSize === b.textSize &&
    a.density === b.density &&
    a.shape === b.shape &&
    resolved(a).join() === resolved(b).join()
  );
}

/* ----------------------------------------------------------------- color */

type Rgb = [number, number, number];

function toRgb(color: string): Rgb {
  return [1, 3, 5].map((start) =>
    parseInt(color.slice(start, start + 2), 16),
  ) as Rgb;
}

function toHex(rgb: Rgb) {
  return `#${rgb.map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
}

/** `weight` of `foreground`, the rest `background`. */
function mix(foreground: string, background: string, weight: number) {
  const front = toRgb(foreground);
  const back = toRgb(background);
  return toHex(
    front.map(
      (value, index) => value * weight + back[index]! * (1 - weight),
    ) as Rgb,
  );
}

function luminance(color: string) {
  const [r, g, b] = toRgb(color).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: string, b: string) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

export const colorTokens = [
  '--bg',
  '--surface',
  '--surface-subtle',
  '--text',
  '--text-muted',
  '--border',
  '--border-subtle',
  '--accent',
  '--on-accent',
  '--selected-bg',
  '--selected-text',
  '--danger',
  '--focus',
] as const;

export type Derived = {
  /** Token values to apply; empty when unchanged or when a pair fails. */
  tokens: Record<string, string>;
  /** Human-readable pairs below their minimum contrast. */
  problems: string[];
};

/** First candidate meeting `minimum` against every background. */
function firstPassing(
  candidates: string[],
  against: string[],
  minimum: number,
) {
  return candidates.find((candidate) =>
    against.every((color) => contrastRatio(candidate, color) >= minimum),
  );
}

/** Derive every color token from the four chosen colors, checking contrast.
 *  Text needs 4.5:1; borders and the accent need 3:1 (WCAG 1.4.3, 1.4.11). */
export function deriveColors(colors: Colors): Derived {
  const chosen = { ...defaultColors, ...colors };
  const { accent, background, surface, text } = chosen;
  if (colorKeys.every((key) => colors[key] === undefined)) {
    return { tokens: {}, problems: [] };
  }
  const problems: string[] = [];
  const check = (label: string, a: string, b: string, minimum: number) => {
    const ratio = contrastRatio(a, b);
    if (ratio < minimum) {
      problems.push(
        `${label} is ${ratio.toFixed(1)}:1; it needs ${minimum}:1.`,
      );
    }
  };
  check('Text on background', text, background, 4.5);
  check('Text on surface', text, surface, 4.5);
  check('Accent on background', accent, background, 3);
  check('Accent on surface', accent, surface, 3);
  const onAccent =
    contrastRatio('#ffffff', accent) >= contrastRatio('#000000', accent)
      ? '#ffffff'
      : '#000000';
  check('Button text on accent', onAccent, accent, 4.5);
  if (problems.length) return { tokens: {}, problems };

  const both = [background, surface];
  const muted =
    firstPassing(
      [0.78, 0.9].map((weight) => mix(text, surface, weight)),
      both,
      4.5,
    ) ?? text;
  const border =
    firstPassing(
      [0.55, 0.65, 0.8].map((weight) => mix(text, surface, weight)),
      both,
      3,
    ) ?? text;
  const selected =
    [0.15, 0.1, 0.05]
      .map((weight) => mix(accent, surface, weight))
      .find((color) => contrastRatio(text, color) >= 4.5) ?? surface;
  return {
    problems,
    tokens: {
      '--bg': background,
      '--surface': surface,
      '--surface-subtle': mix(text, surface, 0.03),
      '--text': text,
      '--text-muted': muted,
      '--border': border,
      '--border-subtle': mix(text, surface, 0.12),
      '--accent': accent,
      '--on-accent': onAccent,
      '--selected-bg': selected,
      '--selected-text': text,
      '--danger': firstPassing(['#a3261b', '#ff9b90', text], both, 4.5) ?? text,
      '--focus': accent,
    },
  };
}

/* ----------------------------------------------------------------- apply */

const darkQuery = '(prefers-color-scheme: dark)';

/** Whether the device asks for dark colors (false where unsupported). */
export function prefersDark() {
  return typeof matchMedia === 'function' && matchMedia(darkQuery).matches;
}

/** Calls back when the device's light/dark setting changes. */
export function watchScheme(callback: () => void) {
  if (typeof matchMedia !== 'function') return () => undefined;
  const query = matchMedia(darkQuery);
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
}

/** The palette in use; e-ink has none of its own. */
export function resolvedScheme(appearance: Appearance) {
  if (appearance.scheme !== 'system') return appearance.scheme;
  return prefersDark() ? 'dark' : 'light';
}

/** Apply to the document. E-ink stays monochrome whatever colors are saved,
 *  and square corners. Custom colors replace the light or dark palette. */
export function applyAppearance(
  appearance: Appearance,
  root: HTMLElement = document.documentElement,
) {
  root.dataset.theme = appearance.eink ? 'eink' : 'standard';
  if (appearance.eink) delete root.dataset.scheme;
  else root.dataset.scheme = resolvedScheme(appearance);
  root.dataset.textSize = appearance.textSize;
  root.dataset.density = appearance.density;
  if (appearance.eink) delete root.dataset.shape;
  else root.dataset.shape = appearance.shape;
  for (const name of colorTokens) root.style.removeProperty(name);
  root.style.removeProperty('color-scheme');
  if (appearance.eink) return;
  const { tokens } = deriveColors(appearance.colors);
  for (const [name, value] of Object.entries(tokens)) {
    root.style.setProperty(name, value);
  }
  // Native widgets (date pickers, scrollbars) follow a dark background.
  if (tokens['--bg']) {
    root.style.setProperty(
      'color-scheme',
      luminance(tokens['--bg']) < 0.18 ? 'dark' : 'light',
    );
  }
}

/* --------------------------------------------------------------- storage */

const einkKey = 'hub:eink';
const appearanceKey = 'hub:appearance';
const profilesKey = 'hub:appearance-profiles';
const activeKey = 'hub:appearance-profile';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // Storage unavailable: defaults.
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* Appearance still applies without storage. */
  }
}

function readJson(key: string): unknown {
  try {
    return JSON.parse(read(key) ?? 'null');
  } catch {
    return null;
  }
}

/** The mode keeps its original key so earlier installs and tests still work. */
export function readAppearance(): Appearance {
  const stored = readJson(appearanceKey);
  return {
    ...parseAppearance(stored),
    eink: read(einkKey) === 'true',
  };
}

export function writeAppearance(appearance: Appearance) {
  write(einkKey, String(appearance.eink));
  write(
    appearanceKey,
    JSON.stringify({
      scheme: appearance.scheme,
      colors: appearance.colors,
      textSize: appearance.textSize,
      density: appearance.density,
      shape: appearance.shape,
    }),
  );
}

/** Saved (non-built-in) profiles; malformed entries are dropped. */
export function readProfiles(): Profile[] {
  const stored = readJson(profilesKey);
  if (!Array.isArray(stored)) return [];
  const profiles: Profile[] = [];
  for (const item of stored.slice(0, maxProfiles)) {
    const entry = (item ?? {}) as Record<string, unknown>;
    if (
      typeof entry.id === 'string' &&
      typeof entry.name === 'string' &&
      entry.name.trim() &&
      !profiles.some((profile) => profile.id === entry.id)
    ) {
      profiles.push({
        id: entry.id,
        name: entry.name.trim().slice(0, maxProfileName),
        appearance: parseAppearance(entry.appearance),
      });
    }
  }
  return profiles;
}

export function writeProfiles(profiles: Profile[]) {
  write(profilesKey, JSON.stringify(profiles));
}

export function readActiveProfile(): string | null {
  return read(activeKey);
}

export function writeActiveProfile(id: string | null) {
  write(activeKey, id);
}
