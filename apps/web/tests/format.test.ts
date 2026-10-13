import { describe, expect, it } from 'vitest';
import { formatInstant } from '../src/lib/format';

const now = new Date(2026, 9, 12, 12, 0);

describe('formatInstant', () => {
  it('omits seconds and the current year', () => {
    const text = formatInstant(new Date(2026, 9, 12, 18, 52, 38), now);
    expect(text).toMatch(/Oct/);
    expect(text).toMatch(/12/);
    expect(text).not.toMatch(/2026/);
    expect(text).not.toMatch(/:38/);
  });

  it('keeps the year for other years', () => {
    expect(formatInstant(new Date(2027, 0, 3, 9, 5), now)).toMatch(/2027/);
  });

  it('does not throw on a bad value', () => {
    expect(formatInstant('not a date', now)).toBe('Unknown time');
  });
});
