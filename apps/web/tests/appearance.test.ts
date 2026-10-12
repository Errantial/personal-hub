import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  defaultAppearance,
  deriveColors,
  parseAppearance,
  sameAppearance,
} from '../src/lib/appearance';

describe('appearance', () => {
  it('measures WCAG contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
  });

  it('falls back field by field on invalid stored data', () => {
    expect(parseAppearance(null)).toEqual(defaultAppearance);
    expect(
      parseAppearance({
        eink: 'yes',
        colors: { accent: 'red', text: '#ABCDEF', extra: '#000000' },
        textSize: 'huge',
        density: 'compact',
        shape: 7,
      }),
    ).toEqual({
      ...defaultAppearance,
      colors: { text: '#abcdef' },
      density: 'compact',
    });
  });

  it('leaves the standard theme untouched without custom colors', () => {
    expect(deriveColors({})).toEqual({ tokens: {}, problems: [] });
  });

  it('derives a complete passing token set for a dark theme', () => {
    const { tokens, problems } = deriveColors({
      background: '#101418',
      surface: '#1a2027',
      text: '#eef2f5',
      accent: '#8fd0ff',
    });
    expect(problems).toEqual([]);
    expect(tokens['--on-accent']).toBe('#000000');
    for (const name of ['--text', '--text-muted', '--danger']) {
      for (const ground of ['--bg', '--surface']) {
        expect(
          contrastRatio(tokens[name]!, tokens[ground]!),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(
      contrastRatio(tokens['--border']!, tokens['--surface']!),
    ).toBeGreaterThanOrEqual(3);
    expect(
      contrastRatio(tokens['--selected-text']!, tokens['--selected-bg']!),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('refuses colors that would be unreadable and says which pair', () => {
    const { tokens, problems } = deriveColors({ text: '#aaaaaa' });
    expect(tokens).toEqual({});
    expect(problems.join(' ')).toContain('Text on background');
    expect(problems.join(' ')).toMatch(/needs 4\.5:1/);
    expect(deriveColors({ accent: '#f0f0f0' }).problems.join(' ')).toContain(
      'Accent on background',
    );
  });

  it('treats a color equal to the default as unchanged', () => {
    expect(
      sameAppearance(defaultAppearance, {
        ...defaultAppearance,
        colors: { accent: '#284b40' },
      }),
    ).toBe(true);
    expect(
      sameAppearance(defaultAppearance, { ...defaultAppearance, eink: true }),
    ).toBe(false);
  });
});
